import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, json, parseDurationInput } from '../utils.js';
import { escapeHtml, fmtPct } from '../format.js';
import { db } from '../db/connection.js';
import { numSetting, boolSetting, setSetting, activeStrategy, setActiveStrategy, strategyById, updateStrategyConfig } from '../db/settings.js';
import { candidateById, latestCandidateByMint, updateCandidateStatus } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import { openPositions } from '../db/positions.js';
import {
  menuKeyboard,
  filtersText,
  filtersKeyboard,
  agentText,
  agentKeyboard,
  navKeyboard,
  mainMenuText,
  walletsText,
  positionsText,
  openPositionsKeyboard,
  candidateButtons,
  positionButtons,
  strategyMenuText,
  strategyKeyboard,
} from './menus.js';
import { sendBatch, sendPositionOpen } from './send.js';
import { candidateSummary, formatPosition } from './format.js';
import { refreshPosition } from '../execution/positions.js';
import { executeLiveSell } from '../execution/router.js';
import { handleCallback, editMenuMessage } from './callbacks.js';
import { consumeNumericFilterInput } from './input.js';
import { runLearning, sendLessons } from '../learning/commands.js';
import { fetchWalletPnl } from '../enrichment/wallets.js';

export async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (await consumeNumericFilterInput(chatId, text, msg.message_id)) return;
  if (!text.startsWith('/')) return;
  if (text.startsWith('/menu')) return sendMenu(chatId);
  if (text.startsWith('/positions')) return sendPositions(chatId);
  if (text.startsWith('/filters')) return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  if (text.startsWith('/strategy')) {
    const parts = text.split(/\s+/);
    const id = parts[1];
    if (!id) {
      return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
    }
    const valid = ['sniper', 'dip_buy', 'smart_money', 'degen'];
    if (!valid.includes(id)) {
      return bot.sendMessage(chatId, `Unknown strategy. Valid: ${valid.join(', ')}`);
    }
    setActiveStrategy(id);
    return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
  }
  if (text.startsWith('/stratset')) {
    const parts = text.split(/\s+/);
    const [, id, key, ...rest] = parts;
    const value = rest.join(' ');
    if (!id || !key || !value) {
      return bot.sendMessage(chatId, 'Usage: /stratset <strategy_id> <key> <value>\n\nExample: /stratset sniper tp_percent 75\nExample: /stratset sniper early_exit_check_after_ms 90s\nExample: /stratset sniper early_loss_window_ms 3m\nExample: /stratset degen max_hold_ms 45m\n\nKeys include: tp_percent, sl_percent, position_size_sol, max_open_positions, max_hold_ms, early_exit_enabled, early_exit_check_after_ms, early_exit_min_peak_pnl_percent, early_exit_max_current_pnl_percent, early_loss_guard_enabled, early_loss_check_after_ms, early_loss_window_ms, early_loss_exit_pnl_percent');
    }
    const strat = strategyById(id);
    if (!strat) return bot.sendMessage(chatId, `Strategy "${id}" not found.`);
    const numKeys = new Set(['tp_percent', 'sl_percent', 'sl_soft_percent', 'sl_hard_percent', 'sl_confirm_min_bad_signals', 'sl_confirm_rsi_below', 'sl_confirm_bb_below', 'sl_confirm_buy_pressure_below', 'position_size_sol', 'max_open_positions', 'min_mcap_usd', 'max_mcap_usd', 'min_holders', 'max_top20_holder_percent', 'trailing_percent', 'trailing_floor_at_percent', 'trailing_floor_percent', 'trailing_tier_1_at_percent', 'trailing_tier_1_percent', 'trailing_tier_2_at_percent', 'trailing_tier_2_percent', 'trailing_tier_3_at_percent', 'trailing_tier_3_percent', 'trailing_tier_4_at_percent', 'trailing_tier_4_percent', 'profit_cooldown_min_profit_percent', 'profit_cooldown_max_wins', 'profit_cooldown_min_loss_percent', 'profit_cooldown_max_losses', 'profit_cooldown_minutes', 'partial_tp_at_percent', 'partial_tp_sell_percent', 'max_hold_ms', 'early_exit_check_after_ms', 'early_exit_min_peak_pnl_percent', 'early_exit_max_current_pnl_percent', 'early_loss_check_after_ms', 'early_loss_window_ms', 'early_loss_exit_pnl_percent', 'llm_min_confidence', 'min_source_count', 'min_fee_claim_sol', 'min_gmgn_total_fee_sol', 'max_ath_distance_pct', 'token_age_max_ms', 'trending_min_volume_usd', 'trending_min_swaps', 'trending_max_rug_ratio', 'trending_max_bundler_rate', 'min_saved_wallet_holders', 'min_graduated_volume_usd', 'supertrend_atr_period', 'supertrend_multiplier', 'rsi_period', 'rsi_min', 'rsi_max', 'bbrsi_overbought_rsi', 'bbrsi_max_band_pos', 'bb_buy_pressure_min_band_pos', 'bb_buy_pressure_min_ratio', 'buy_pressure_min_ratio', 'fresh_mcap_max_drop_percent', 'bb_period', 'bb_stddev']);
    const boolKeys = new Set(['trailing_enabled', 'trailing_tiers_enabled', 'profit_cooldown_enabled', 'early_exit_enabled', 'early_exit_confirmation_enabled', 'early_loss_guard_enabled', 'partial_tp', 'use_llm', 'require_fee_claim', 'source_gate_enabled', 'source_require_fee', 'source_require_graduated', 'source_require_trending', 'chart_indicators_enabled', 'chart_indicators_hard_filter', 'supertrend_required', 'rsi_guard_enabled', 'bbrsi_guard_enabled', 'bb_buy_pressure_guard_enabled', 'buy_pressure_guard_enabled', 'fresh_mcap_dump_guard_enabled', 'sl_confirmation_enabled', 'sl_confirm_supertrend_bearish']);
    const durationKeys = new Set(['max_hold_ms', 'early_exit_check_after_ms', 'early_loss_check_after_ms', 'early_loss_window_ms']);
    const newConfig = { ...strat };
    delete newConfig.id;
    delete newConfig.name;
    if (durationKeys.has(key)) {
      const parsed = parseDurationInput(value);
      if (parsed == null) return bot.sendMessage(chatId, `Invalid ${key}. Use 90s, 45m, 1h, 1h30m, 2h, or off.`);
      newConfig[key] = parsed;
    } else if (numKeys.has(key)) {
      newConfig[key] = Number(value);
    } else if (boolKeys.has(key)) {
      newConfig[key] = value === 'true' || value === '1' || value === 'yes';
    } else {
      newConfig[key] = value;
    }
    updateStrategyConfig(id, newConfig);
    return bot.sendMessage(chatId, `Updated ${id}.${key} = ${value}\n\n${strategyMenuText()}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/pnl')) return sendPnl(chatId);
  if (text.startsWith('/learn')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return runLearning(chatId, windowArg);
  }
  if (text.startsWith('/lessons')) return sendLessons(chatId);
  if (text.startsWith('/candidate')) {
    const mint = text.split(/\s+/)[1];
    if (!mint) return bot.sendMessage(chatId, 'Usage: /candidate <mint>');
    const row = latestCandidateByMint(mint);
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    return sendCandidate(chatId, row.id);
  }
  if (text.startsWith('/walletadd')) {
    const [, label, address] = text.split(/\s+/);
    if (!label || !address) return bot.sendMessage(chatId, 'Usage: /walletadd <label> <address>');
    db.prepare(`
      INSERT INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address
    `).run(label, address, now());
    return bot.sendMessage(chatId, `Saved wallet ${label}.`);
  }
  if (text.startsWith('/walletremove')) {
    const label = text.split(/\s+/)[1];
    if (!label) return bot.sendMessage(chatId, 'Usage: /walletremove <label>');
    db.prepare('DELETE FROM saved_wallets WHERE label = ?').run(label);
    return bot.sendMessage(chatId, `Removed ${label}.`);
  }
  if (text.startsWith('/wallets')) return handleCallback({ id: 'manual', data: 'menu:wallets', message: { chat: { id: chatId } } });
  if (text.startsWith('/setfilter')) {
    const { key, value } = parseSetFilter(text);
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
    if (!valid.has(key) || value == null) {
      return bot.sendMessage(chatId, `Usage: /setfilter &lt;name&gt; &lt;value&gt;\n\n${filtersText()}`, { parse_mode: 'HTML' });
    }
    const strategyNumKeys = new Set(['tp_percent', 'sl_percent', 'sl_soft_percent', 'sl_hard_percent', 'sl_confirm_min_bad_signals', 'sl_confirm_rsi_below', 'sl_confirm_bb_below', 'sl_confirm_buy_pressure_below', 'position_size_sol', 'max_open_positions', 'min_mcap_usd', 'max_mcap_usd', 'min_holders', 'max_top20_holder_percent', 'trailing_percent', 'trailing_floor_at_percent', 'trailing_floor_percent', 'trailing_tier_1_at_percent', 'trailing_tier_1_percent', 'trailing_tier_2_at_percent', 'trailing_tier_2_percent', 'trailing_tier_3_at_percent', 'trailing_tier_3_percent', 'trailing_tier_4_at_percent', 'trailing_tier_4_percent', 'profit_cooldown_min_profit_percent', 'profit_cooldown_max_wins', 'profit_cooldown_min_loss_percent', 'profit_cooldown_max_losses', 'profit_cooldown_minutes', 'partial_tp_at_percent', 'partial_tp_sell_percent', 'max_hold_ms', 'early_exit_check_after_ms', 'early_exit_min_peak_pnl_percent', 'early_exit_max_current_pnl_percent', 'early_loss_check_after_ms', 'early_loss_window_ms', 'early_loss_exit_pnl_percent', 'llm_min_confidence', 'min_source_count', 'min_fee_claim_sol', 'min_gmgn_total_fee_sol', 'max_ath_distance_pct', 'token_age_max_ms', 'trending_min_volume_usd', 'trending_min_swaps', 'trending_max_rug_ratio', 'trending_max_bundler_rate', 'min_saved_wallet_holders', 'min_graduated_volume_usd', 'supertrend_atr_period', 'supertrend_multiplier', 'rsi_period', 'rsi_min', 'rsi_max', 'bbrsi_overbought_rsi', 'bbrsi_max_band_pos', 'bb_buy_pressure_min_band_pos', 'bb_buy_pressure_min_ratio', 'buy_pressure_min_ratio', 'fresh_mcap_max_drop_percent', 'bb_period', 'bb_stddev']);
    const strategyBoolKeys = new Set(['trailing_enabled', 'trailing_tiers_enabled', 'profit_cooldown_enabled', 'early_exit_enabled', 'early_exit_confirmation_enabled', 'early_loss_guard_enabled', 'partial_tp', 'use_llm', 'require_fee_claim', 'source_gate_enabled', 'source_require_fee', 'source_require_graduated', 'source_require_trending', 'chart_indicators_enabled', 'chart_indicators_hard_filter', 'supertrend_required', 'rsi_guard_enabled', 'bbrsi_guard_enabled', 'bb_buy_pressure_guard_enabled', 'buy_pressure_guard_enabled', 'fresh_mcap_dump_guard_enabled', 'sl_confirmation_enabled', 'sl_confirm_supertrend_bearish']);
    const durationKeys = new Set(['max_hold_ms', 'early_exit_check_after_ms', 'early_loss_check_after_ms', 'early_loss_window_ms']);
    if (strategyNumKeys.has(key) || strategyBoolKeys.has(key)) {
      const strat = activeStrategy();
      const newConfig = { ...strat };
      delete newConfig.id;
      delete newConfig.name;
      if (durationKeys.has(key)) {
        const parsed = parseDurationInput(value);
        if (parsed == null) return bot.sendMessage(chatId, `Invalid ${key}. Use 90s, 45m, 1h, 1h30m, 2h, or off.`);
        newConfig[key] = parsed;
      } else if (strategyNumKeys.has(key)) {
        newConfig[key] = Number(value === 'off' ? 0 : value);
      } else {
        newConfig[key] = value === 'true' || value === '1' || value === 'yes' || value === 'on';
      }
      updateStrategyConfig(strat.id, newConfig);
      return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
    }
    setSetting(key, value === 'off' ? '0' : value);
    return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  }
}

export async function sendCandidate(chatId, id) {
  const row = candidateById(id);
  if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
  const decision = db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  await bot.sendMessage(chatId, candidateSummary(row.candidate, decision), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...candidateButtons(id, decision),
  });
}

export async function sendPositions(chatId) {
  await bot.sendMessage(chatId, positionsText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...openPositionsKeyboard(),
  });
}

export async function sendPosition(chatId, id, query = null) {
  let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  if (row.status === 'open') {
    const refreshed = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      console.log(`[position] refresh ${id} ${err.message}`);
      return null;
    });
    if (refreshed) {
      row = { ...row, ...refreshed };
      if (refreshed.exitReason) {
        await sendClosedPositionNarrative(chatId, row, refreshed.exitReason).catch((err) => {
          console.log(`[position] exit notification ${id} ${err.message}`);
        });
      }
    }
  }
  const buttons = row.status === 'open' ? positionButtons(id) : {};
  if (query) return editMenuMessage(query, formatPosition(row), buttons);
  await bot.sendMessage(chatId, formatPosition(row), { parse_mode: 'HTML', disable_web_page_preview: true, ...buttons });
}

async function sendClosedPositionNarrative(chatId, position, reason = null) {
  const exitReason = reason || position.exitReason || position.exit_reason || 'closed';
  const closedPosition = {
    ...position,
    status: 'closed',
    exitReason,
    exit_reason: exitReason,
  };
  return bot.sendMessage(chatId, formatPosition(closedPosition), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

export async function refreshOpenPositions(chatId, query = null) {
  const rows = openPositions();
  let refreshed = 0;
  let closed = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      failed++;
      console.log(`[position] refresh all ${row.id} ${err.message}`);
      return null;
    });
    if (!result) continue;
    refreshed++;
    if (result.status === 'closed' || result.exitReason) {
      closed++;
      await sendClosedPositionNarrative(chatId, result, result.exitReason || result.exit_reason).catch((err) => {
        console.log(`[position] exit notification ${row.id} ${err.message}`);
      });
    }
  }
  const summary = [
    `🔄 <b>Refreshed open positions</b>`,
    `Checked: ${rows.length} · Updated: ${refreshed}${closed ? ` · Closed: ${closed}` : ''}${failed ? ` · Failed: ${failed}` : ''}`,
  ].join('\n');
  const text = `${summary}\n\n${positionsText()}`;
  if (query) return editMenuMessage(query, text, openPositionsKeyboard());
  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...openPositionsKeyboard(),
  });
}

export async function closePosition(chatId, id, reason, query = null) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row || row.status !== 'open') return bot.sendMessage(chatId, 'Open position not found.');
  const result = await refreshPosition(row, { autoExit: false });
  const price = result?.price ?? row.high_water_price ?? row.entry_price;
  const mcap = result?.mcap ?? row.high_water_mcap ?? row.entry_mcap;
  const pnlPercent = row.entry_mcap ? (Number(mcap) / Number(row.entry_mcap) - 1) * 100 : 0;
  const pnlSol = Number(row.size_sol) * pnlPercent / 100;
  let sell = null;
  if (row.execution_mode === 'live') sell = await executeLiveSell(row, reason);
  const closedAt = now();
  db.prepare(`
    UPDATE dry_run_positions
    SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
        pnl_percent = ?, pnl_sol = ?, exit_signature = ?
    WHERE id = ?
  `).run(closedAt, price, mcap, reason, pnlPercent, pnlSol, sell?.signature || null, id);
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.mint, closedAt, price, mcap, row.size_sol, row.token_amount_est, reason, json({ pnlPercent, pnlSol, sell }));
  const closedPosition = {
    ...row,
    status: 'closed',
    closed_at_ms: closedAt,
    high_water_mcap: result?.high_water_mcap ?? row.high_water_mcap,
    high_water_price: result?.high_water_price ?? row.high_water_price,
    exit_price: price,
    exit_mcap: mcap,
    exit_reason: reason,
    exitReason: reason,
    pnl_percent: pnlPercent,
    pnl_sol: pnlSol,
    exit_signature: sell?.signature || null,
  };
  await sendClosedPositionNarrative(chatId, closedPosition, reason);
  if (query) return editMenuMessage(query, formatPosition(closedPosition), {});
}

export async function updatePositionRule(chatId, id, field, nextValue, query = null) {
  if (!Number.isFinite(nextValue)) return bot.sendMessage(chatId, 'Invalid value.');
  db.prepare(`UPDATE dry_run_positions SET ${field} = ? WHERE id = ?`).run(nextValue, id);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (row) {
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id) DO UPDATE SET
        tp_percent = excluded.tp_percent,
        sl_percent = excluded.sl_percent,
        trailing_enabled = excluded.trailing_enabled,
        trailing_percent = excluded.trailing_percent,
        updated_at_ms = excluded.updated_at_ms
    `).run(id, row.tp_percent, row.sl_percent, row.trailing_enabled, row.trailing_percent, now());
  }
  await sendPosition(chatId, id, query);
}

export async function toggleTrailing(chatId, id, query = null) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  const next = row.trailing_enabled ? 0 : 1;
  db.prepare('UPDATE dry_run_positions SET trailing_enabled = ? WHERE id = ?').run(next, id);
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET
      tp_percent = excluded.tp_percent,
      sl_percent = excluded.sl_percent,
      trailing_enabled = excluded.trailing_enabled,
      trailing_percent = excluded.trailing_percent,
      updated_at_ms = excluded.updated_at_ms
  `).run(id, row.tp_percent, row.sl_percent, next, row.trailing_percent, now());
  await sendPosition(chatId, id, query);
}

export function setupTelegram() {
  bot.setMyCommands([
    { command: 'menu', description: 'Open Charon menu' },
    { command: 'strategy', description: 'Show/switch strategy' },
    { command: 'stratset', description: 'Set strategy config (stratset id key value)' },
    { command: 'positions', description: 'Show dry-run positions' },
    { command: 'candidate', description: 'Show candidate by mint' },
    { command: 'filters', description: 'Show filters' },
    { command: 'pnl', description: 'Show saved-wallet PnL' },
    { command: 'learn', description: 'Run manual learning report' },
    { command: 'lessons', description: 'Show active screening lessons' },
    { command: 'setfilter', description: 'Set a filter value' },
    { command: 'walletadd', description: 'Save wallet for exposure/PnL' },
    { command: 'walletremove', description: 'Remove saved wallet' },
    { command: 'wallets', description: 'List saved wallets' },
  ]).catch(err => console.log(`[telegram] commands ${err.message}`));

  bot.on('callback_query', query => handleCallback(query).catch(err => console.log(`[callback] ${err.message}`)));
  bot.on('message', msg => handleMessage(msg).catch(err => console.log(`[message] ${err.message}`)));
  bot.on('polling_error', err => console.log(`[telegram] polling ${err.message}`));
}

async function sendMenu(chatId = TELEGRAM_CHAT_ID) {
  const { TELEGRAM_TOPIC_ID } = await import('../config.js');
  await bot.sendMessage(chatId, mainMenuText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...menuKeyboard(),
  });
}

async function sendPnl(chatId, query = null) {
  const wallets = savedWallets();
  if (!wallets.length) {
    const text = '📊 <b>PnL</b>\n\nNo saved wallets. Use /walletadd &lt;label&gt; &lt;address&gt;.';
    return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }
  const chunks = [];
  for (const wallet of wallets) {
    const pnl = await fetchWalletPnl(wallet.address).catch(() => null);
    if (!pnl) {
      chunks.push(`• <b>${escapeHtml(wallet.label)}</b>: no data`);
      continue;
    }
    chunks.push([
      `• <b>${escapeHtml(wallet.label)}</b>`,
      `Win: ${fmtPct(pnl.winRate)} · PnL: ${fmtPct(pnl.totalPnlPercent)}`,
      `Trades: ${pnl.totalTrades} · Wins: ${pnl.wins}`,
    ].join('\n'));
  }
  const text = `📊 <b>PnL</b>\n\n${chunks.join('\n\n')}`;
  return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

function parseSetFilter(text) {
  const parts = text.trim().split(/\s+/);
  return { key: parts[1], value: parts[2] };
}

function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}
