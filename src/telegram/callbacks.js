import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { formatDuration, now } from '../utils.js';
import { numSetting, boolSetting, setSetting, setActiveStrategy, activeStrategy, updateStrategyConfig } from '../db/settings.js';
import {
  menuKeyboard,
  filtersText,
  filtersKeyboard,
  agentText,
  agentKeyboard,
  navKeyboard,
  mainMenuText,
  activeStrategyJsonText,
  walletsText,
  positionsText,
  openPositionsKeyboard,
  closedHistoryText,
  cooldownText,
  cooldownKeyboard,
  topWinsText,
  topLossesText,
  candidateButtons,
  sendTpSlDefaults,
  strategyMenuText,
  strategyKeyboard,
} from './menus.js';
import { sendTelegram, sendBatch, sendPositionOpen, sendTradeIntent } from './send.js';
import { candidateSummary } from './format.js';
import { candidateById, updateCandidateStatus } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import { createDryRunPosition, canOpenMorePositions, openPositionByMint, openPositionCount, tradingMode } from '../db/positions.js';
import { executeLiveBuy, executeConfirmedIntent, rejectIntent } from '../execution/router.js';
import { sendCandidate, sendPosition, closePosition, updatePositionRule, toggleTrailing, refreshOpenPositions } from './commands.js';
import { requestNumericFilterInput, requestStrategyNumericInput } from './input.js';

export async function handleCallback(query) {
  const data = query.data || '';
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  await answerCallback(query);
  if (!data.startsWith('input:') && !data.startsWith('stratinput:')) {
    const { pendingNumericInputs } = await import('./input.js');
    pendingNumericInputs.delete(String(chatId));
  }

  if (data === 'menu:main') return editMenuMessage(query, mainMenuText(), menuKeyboard());
  if (data === 'noop') return null;
  if (data === 'menu:close') return closeMenuMessage(query);
  if (data === 'menu:agent') {
    return editMenuMessage(query, agentText(), agentKeyboard());
  }
  if (data === 'toggle:agent') {
    setSetting('agent_enabled', boolSetting('agent_enabled', true) ? 'false' : 'true');
    return editMenuMessage(query, agentText(), agentKeyboard());
  }
  if (data === 'toggle:trending_enabled' || data === 'toggle:trending_allow_degen') {
    const key = data.replace('toggle:', '');
    setSetting(key, boolSetting(key, key === 'trending_enabled') ? 'false' : 'true');
    return editMenuMessage(query, filtersText(), filtersKeyboard());
  }
  if (data === 'menu:filters') return editMenuMessage(query, filtersText(), filtersKeyboard());
  if (data === 'menu:strategy') return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  if (data === 'menu:active_strategy') return editMenuMessage(query, activeStrategyJsonText(), navKeyboard([
    [
      { text: 'Strategy', callback_data: 'menu:strategy' },
      { text: 'Cooldown', callback_data: 'menu:cooldown' },
    ],
  ]));
  if (data === 'menu:cooldown') return editMenuMessage(query, cooldownText(), cooldownKeyboard());
  if (data === 'menu:wallets') return editMenuMessage(query, walletsText(), navKeyboard());
  if (data === 'menu:positions') return editMenuMessage(query, positionsText(), openPositionsKeyboard());
  if (data === 'menu:history') return editMenuMessage(query, closedHistoryText(), navKeyboard());
  if (data === 'menu:topwins') return editMenuMessage(query, topWinsText(), navKeyboard());
  if (data === 'menu:toplosses') return editMenuMessage(query, topLossesText(), navKeyboard());
  if (data === 'menu:pnl') {
    const { sendPnl } = await import('./send.js');
    return sendPnl(chatId, query);
  }
  if (data === 'menu:settings') return editMenuMessage(query, `${agentText()}\n\n${filtersText()}`, navKeyboard([
    [
      { text: 'Agent', callback_data: 'menu:agent' },
      { text: 'Filters', callback_data: 'menu:filters' },
    ],
  ]));

  if (data.startsWith('strategy:select:')) {
    const strategyId = data.replace('strategy:select:', '');
    setActiveStrategy(strategyId);
    return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  }
  if (data.startsWith('stratcfg:')) {
    const key = data.replace('stratcfg:', '');
    return handleStratConfig(query, chatId, key);
  }
  if (data.startsWith('stratinput:')) {
    const key = data.replace('stratinput:', '');
    return requestStrategyNumericInput(query, key);
  }
  if (data.startsWith('cooldowncfg:')) {
    const key = data.replace('cooldowncfg:', '');
    return handleCooldownConfig(query, key);
  }
  if (data.startsWith('cooldowninput:')) {
    const key = data.replace('cooldowninput:', '');
    return requestStrategyNumericInput(query, key, 'cooldown');
  }

  const [kind, id, value] = data.split(':');
  if (kind === 'input') return requestNumericFilterInput(query, id);
  if (kind === 'set') return updateSettingFromButton(query, id, value);
  if (kind === 'batch') return sendBatch(chatId, Number(id));
  if (kind === 'positions' && id === 'refresh') return refreshOpenPositions(chatId, query);
  if (kind === 'intent') {
    if (value === 'confirm') return executeConfirmedIntent(chatId, Number(id));
    if (value === 'reject') return rejectIntent(chatId, Number(id));
  }
  if (kind === 'cand') return sendCandidate(chatId, Number(id));
  if (kind === 'ign') {
    updateCandidateStatus(Number(id), 'ignored');
    return bot.sendMessage(chatId, 'Ignored candidate.');
  }
  if (kind === 'buy') {
    const row = candidateById(Number(id));
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    const strat = activeStrategy();
    if (!canOpenMorePositions()) {
      const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
      return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${max}). Close one first or raise the limit.`);
    }
    const candidate = row.candidate;
    const existingOpenPosition = openPositionByMint(candidate.token?.mint);
    if (existingOpenPosition) {
      return bot.sendMessage(chatId, `Open position already exists for this token (#${existingOpenPosition.id}).`);
    }
    const decision = {
      verdict: 'BUY',
      confidence: 100,
      reason: 'Manual dry buy',
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
    };
    const decisionId = storeDecision(row.id, candidate, decision);
    decision.id = decisionId;
    if (tradingMode() === 'live') {
      await executeLiveBuy(row, decision, 'manual', [row], row.id);
      return;
    }
    let positionId;
    try {
      positionId = await createDryRunPosition(row.id, candidate, decision, 'manual_buy');
    } catch (err) {
      if (err.code === 'OPEN_POSITION_EXISTS') {
        return bot.sendMessage(chatId, `Open position already exists for this token (#${err.positionId}).`);
      }
      throw err;
    }
    logDecisionEvent({
      batchId: 'manual',
      triggerCandidateId: row.id,
      selectedRow: row,
      rows: [row],
      decision,
      mode: tradingMode(),
      action: 'manual_dry_run_entry',
      execution: { positionId },
    });
    return sendPositionOpen(positionId);
  }
  if (kind === 'tpsl') return sendTpSlDefaults(chatId, query);
  if (kind === 'pos') return sendPosition(chatId, Number(id), query);
  if (kind === 'sell') return closePosition(chatId, Number(id), 'MANUAL', query);
  if (kind === 'tp') return updatePositionRule(chatId, Number(id), 'tp_percent', Number(value), query);
  if (kind === 'sl') return updatePositionRule(chatId, Number(id), 'sl_percent', Number(value), query);
  if (kind === 'trail') return toggleTrailing(chatId, Number(id), query);
  return null;
}

function handleCooldownConfig(query, key) {
  const strat = activeStrategy();
  if (key !== 'profit_cooldown_enabled') return null;
  const newConfig = { ...strat, profit_cooldown_enabled: !strat.profit_cooldown_enabled };
  delete newConfig.id;
  delete newConfig.name;
  updateStrategyConfig(strat.id, newConfig);
  return editMenuMessage(query, cooldownText(), cooldownKeyboard());
}

async function answerCallback(query, text = '') {
  await bot.answerCallbackQuery(query.id, text ? { text } : undefined).catch(() => {});
}

async function closeMenuMessage(query) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  if (!messageId) return null;
  return bot.deleteMessage(chatId, messageId).catch(() => null);
}

export async function editMenuMessage(query, text, extra = {}) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  if (!messageId) {
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
}

const STRAT_PRESETS = {
  tp_percent: [25, 50, 75, 100, 150, 200],
  sl_percent: [-10, -15, -20, -25, -30, -40, -50],
  sl_soft_percent: [-10, -15, -20, -25, -30],
  sl_hard_percent: [-25, -30, -40, -50, -60],
  sl_confirm_min_bad_signals: [1, 2, 3, 4],
  sl_confirm_rsi_below: [30, 35, 38, 40, 42, 45],
  sl_confirm_bb_below: [15, 20, 25, 30, 35],
  sl_confirm_buy_pressure_below: [0.5, 0.7, 0.8, 0.9, 1.0, 1.1],
  position_size_sol: [0.02, 0.05, 0.1, 0.2, 0.5],
  max_open_positions: [1, 2, 3, 5, 10],
  min_mcap_usd: [0, 5000, 10000, 25000, 50000, 100000],
  max_mcap_usd: [0, 50000, 100000, 200000, 500000, 1000000],
  trailing_percent: [5, 10, 15, 20, 25, 30],
  trailing_floor_at_percent: [0, 10, 15, 20, 25, 30],
  trailing_floor_percent: [0, 3, 5, 7, 10, 15],
  trailing_tier_1_at_percent: [0, 20, 30, 40, 50],
  trailing_tier_1_percent: [0, 5, 10, 15, 20, 25, 30],
  trailing_tier_2_at_percent: [0, 30, 40, 50, 60, 70],
  trailing_tier_2_percent: [0, 10, 15, 20, 30, 40, 50],
  trailing_tier_3_at_percent: [0, 50, 60, 70, 90, 120],
  trailing_tier_3_percent: [0, 10, 15, 20, 25, 30, 40, 50],
  trailing_tier_4_at_percent: [0, 70, 90, 100, 120, 150, 200],
  trailing_tier_4_percent: [0, 15, 20, 25, 30, 40, 50],
  profit_cooldown_min_profit_percent: [0, 3, 5, 10, 15, 20],
  profit_cooldown_max_wins: [0, 1, 2, 3, 5],
  profit_cooldown_min_loss_percent: [0, 10, 15, 17, 20, 25, 30],
  profit_cooldown_max_losses: [0, 1, 2, 3, 5],
  profit_cooldown_minutes: [0, 10, 30, 60, 120],
  early_exit_check_after_ms: [0, 60000, 90000, 120000, 180000],
  early_exit_min_peak_pnl_percent: [0, 3, 5, 7, 10],
  early_exit_max_current_pnl_percent: [-5, -3, 0, 2, 5],
  early_loss_check_after_ms: [0, 30000, 60000, 90000, 120000],
  early_loss_window_ms: [0, 120000, 180000, 300000, 600000],
  early_loss_exit_pnl_percent: [-5, -7, -10, -12, -15],
  min_source_count: [1, 2, 3, 4],
  min_holders: [0, 100, 500, 1000, 2000, 5000],
  llm_min_confidence: [0, 30, 50, 60, 70, 80, 90],
  partial_tp_at_percent: [25, 50, 75, 100, 150, 200],
  partial_tp_sell_percent: [25, 33, 50, 75],
  max_hold_ms: [0, 1800000, 2700000, 3600000, 5400000, 7200000, 14400000],
  min_fee_claim_sol: [0, 0.5, 1, 2, 5, 10],
  min_gmgn_total_fee_sol: [0, 3, 5, 10, 20],
  max_ath_distance_pct: [0, -20, -30, -40, -50, -60],
  token_age_max_ms: [0, 1800000, 3600000, 7200000, 14400000, 43200000, 86400000],
  supertrend_atr_period: [7, 10, 14, 20],
  supertrend_multiplier: [2, 2.5, 3, 3.5, 4],
  rsi_period: [7, 10, 14, 20],
  rsi_min: [0, 35, 40, 45, 50],
  rsi_max: [0, 70, 75, 78, 82, 90],
  bbrsi_overbought_rsi: [70, 75, 78, 82, 90],
  bbrsi_max_band_pos: [95, 100, 105, 110, 120],
  bb_buy_pressure_min_band_pos: [60, 70, 75, 80, 85, 90],
  bb_buy_pressure_min_ratio: [1.2, 1.3, 1.5, 1.7, 2],
  buy_pressure_min_ratio: [0, 1.4, 1.6, 1.8, 2, 2.2, 2.5],
  fresh_mcap_max_drop_percent: [0, 3, 5, 7, 10, 15],
  bb_period: [14, 20, 30],
  bb_stddev: [1.5, 2, 2.5, 3],
};

function formatStratValue(key, value) {
  if (key === 'max_hold_ms' || key === 'token_age_max_ms' || key === 'early_exit_check_after_ms' || key === 'early_loss_check_after_ms' || key === 'early_loss_window_ms') {
    return value > 0 ? formatDuration(value) : 'off';
  }
  if (key.includes('percent') || key.includes('pct')) return `${value}%`;
  if (key.includes('sol')) return `${value} SOL`;
  if (key.includes('usd')) return value > 0 ? `$${value.toLocaleString()}` : 'off';
  return String(value);
}

async function handleStratConfig(query, chatId, key) {
  const strat = activeStrategy();
  const newConfig = { ...strat };
  delete newConfig.id;
  delete newConfig.name;

  if (key === 'indicator_timeframe') {
    newConfig.indicator_timeframe = (strat.indicator_timeframe || '1m') === '1m' ? '5m' : '1m';
    updateStrategyConfig(strat.id, newConfig);
    return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  }

  // Boolean toggles
  const boolKeys = new Set(['trailing_enabled', 'trailing_tiers_enabled', 'profit_cooldown_enabled', 'early_exit_enabled', 'early_exit_confirmation_enabled', 'early_loss_guard_enabled', 'partial_tp', 'use_llm', 'require_fee_claim', 'source_gate_enabled', 'source_require_fee', 'source_require_graduated', 'source_require_trending', 'chart_indicators_enabled', 'chart_indicators_hard_filter', 'supertrend_required', 'rsi_guard_enabled', 'bbrsi_guard_enabled', 'bb_buy_pressure_guard_enabled', 'buy_pressure_guard_enabled', 'fresh_mcap_dump_guard_enabled', 'sl_confirmation_enabled', 'sl_confirm_supertrend_bearish']);
  if (boolKeys.has(key)) {
    newConfig[key] = !strat[key];
    updateStrategyConfig(strat.id, newConfig);
    return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  }

  // Cycle through presets
  const presets = STRAT_PRESETS[key];
  if (presets) {
    const current = Number(strat[key] ?? 0);
    const idx = presets.indexOf(current);
    const next = idx >= 0 ? presets[(idx + 1) % presets.length] : presets[0];
    newConfig[key] = next;
    updateStrategyConfig(strat.id, newConfig);
    return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  }

  // Fallback: show current value
  return bot.sendMessage(chatId, `Current ${key}: ${formatStratValue(key, strat[key])}\nUse /stratset ${strat.id} ${key} <value> to change.`);
}

async function updateSettingFromButton(query, key, value) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const valid = new Set([
    'min_fee_claim_sol',
    'min_mcap_usd',
    'max_mcap_usd',
    'min_gmgn_total_fee_sol',
    'min_graduated_volume_usd',
    'max_top20_holder_percent',
    'min_saved_wallet_holders',
    'trending_enabled',
    'trending_source',
    'trending_allow_degen',
    'trending_interval',
    'trending_limit',
    'trending_order_by',
    'trending_min_volume_usd',
    'trending_min_swaps',
    'trending_max_rug_ratio',
    'trending_max_bundler_rate',
    'trading_mode',
    'llm_min_confidence',
    'llm_candidate_pick_count',
    'llm_candidate_max_age_ms',
    'max_open_positions',
    'dry_run_buy_sol',
    'default_tp_percent',
    'default_sl_percent',
    'default_trailing_enabled',
    'default_trailing_percent',
  ]);
  if (!valid.has(key) || value == null) return bot.sendMessage(chatId, 'Unknown setting.');
  const strategyButtonKeys = new Set(['max_open_positions', 'llm_min_confidence']);
  if (strategyButtonKeys.has(key)) {
    const strat = activeStrategy();
    const newConfig = { ...strat, [key]: Number(value) };
    delete newConfig.id;
    delete newConfig.name;
    updateStrategyConfig(strat.id, newConfig);
    return editMenuMessage(query, agentText(), agentKeyboard());
  }
  setSetting(key, value);
  const text = key.startsWith('default_') || key === 'dry_run_buy_sol' || key === 'trading_mode' || key === 'llm_min_confidence' || key === 'llm_candidate_pick_count' || key === 'llm_candidate_max_age_ms' || key === 'max_open_positions'
    ? agentText()
    : filtersText();
  const extra = key.startsWith('default_') || key === 'dry_run_buy_sol' || key === 'trading_mode' || key === 'llm_min_confidence' || key === 'llm_candidate_pick_count' || key === 'llm_candidate_max_age_ms' || key === 'max_open_positions'
    ? agentKeyboard()
    : filtersKeyboard();
  return editMenuMessage(query, text, extra);
}
