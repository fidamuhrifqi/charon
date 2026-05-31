import { escapeHtml, fmtPct, fmtSol, fmtUsd, short } from '../format.js';
import { numSetting, boolSetting, setting, activeStrategy, allStrategies } from '../db/settings.js';
import { openPositionCount, openPositions, tradingMode } from '../db/positions.js';
import { savedWallets } from '../enrichment/wallets.js';
import { gmgnStatusText } from '../enrichment/gmgn.js';
import { formatExitReason, formatPosition } from './format.js';
import { ENABLE_LLM, LLM_API_KEY } from '../config.js';
import { db } from '../db/connection.js';
import { formatDuration } from '../utils.js';
import { trailingTierText } from '../execution/trailing.js';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function todayWibBounds(atMs = Date.now()) {
  const dayIndex = Math.floor((Number(atMs) + WIB_OFFSET_MS) / DAY_MS);
  const startMs = dayIndex * DAY_MS - WIB_OFFSET_MS;
  return { startMs, endMs: startMs + DAY_MS };
}

function closedPnl({ startMs = null, endMs = null } = {}) {
  const clauses = ["status = 'closed'"];
  const params = [];
  if (startMs != null) {
    clauses.push('COALESCE(closed_at_ms, opened_at_ms) >= ?');
    params.push(startMs);
  }
  if (endMs != null) {
    clauses.push('COALESCE(closed_at_ms, opened_at_ms) < ?');
    params.push(endMs);
  }
  const closed = db.prepare(`
    SELECT pnl_percent, pnl_sol, size_sol, exit_reason
    FROM dry_run_positions
    WHERE ${clauses.join(' AND ')}
  `).all(...params);
  if (!closed.length) {
    return { count: 0, wins: 0, losses: 0, flats: 0, winRate: 0, lossRate: 0, flatRate: 0, grossWinSol: 0, grossLossSol: 0, totalPnlPercent: 0, totalPnlSol: 0, totalSizeSol: 0, exitTp: 0, exitSl: 0, exitMaxHold: 0, exitEarly: 0, exitManual: 0, exitOther: 0 };
  }
  const totalPnlSol = closed.reduce((sum, p) => sum + Number(p.pnl_sol || 0), 0);
  const grossWinSol = closed.reduce((sum, p) => {
    const pnl = Number(p.pnl_sol || 0);
    return pnl > 0 ? sum + pnl : sum;
  }, 0);
  const grossLossSol = closed.reduce((sum, p) => {
    const pnl = Number(p.pnl_sol || 0);
    return pnl < 0 ? sum + pnl : sum;
  }, 0);
  const totalSizeSol = closed.reduce((sum, p) => sum + Number(p.size_sol || 0), 0);
  const summedPnlPercent = closed.reduce((sum, p) => sum + Number(p.pnl_percent || 0), 0);
  const totalPnlPercent = totalSizeSol > 0 ? (totalPnlSol / totalSizeSol) * 100 : summedPnlPercent;
  const wins = closed.filter(p => Number(p.pnl_sol ?? p.pnl_percent ?? 0) > 0).length;
  const losses = closed.filter(p => Number(p.pnl_sol ?? p.pnl_percent ?? 0) < 0).length;
  const flats = closed.length - wins - losses;
  const exitCounts = closed.reduce((counts, row) => {
    const reason = String(row.exit_reason || '').toUpperCase();
    if (reason === 'SL' || reason === 'SOFT_SL' || reason === 'HARD_SL') counts.exitSl += 1;
    else if (reason === 'MAX_HOLD') counts.exitMaxHold += 1;
    else if (reason === 'EARLY_STAGNATION' || reason === 'EARLY_WEAKNESS') counts.exitEarly += 1;
    else if (reason === 'TP' || reason === 'TRAILING_TP' || reason === 'PARTIAL_TP') counts.exitTp += 1;
    else if (reason === 'MANUAL') counts.exitManual += 1;
    else counts.exitOther += 1;
    return counts;
  }, { exitTp: 0, exitSl: 0, exitMaxHold: 0, exitEarly: 0, exitManual: 0, exitOther: 0 });
  return {
    count: closed.length,
    wins,
    losses,
    flats,
    winRate: (wins / closed.length) * 100,
    lossRate: (losses / closed.length) * 100,
    flatRate: (flats / closed.length) * 100,
    grossWinSol,
    grossLossSol,
    totalPnlPercent,
    totalPnlSol,
    totalSizeSol,
    ...exitCounts,
  };
}

function pnlSummaryLines(prefix, pnl) {
  if (!pnl.count) return [`${prefix} ROI: <b>no closed trades</b>`];
  const manualOrOther = [
    pnl.exitManual ? `Manual: <b>${pnl.exitManual}</b>` : null,
    pnl.exitOther ? `Other: <b>${pnl.exitOther}</b>` : null,
  ].filter(Boolean).join(' · ');
  return [
    `${prefix} ROI: <b>${fmtPct(pnl.totalPnlPercent)}</b>`,
    `Net / closed size: <b>${fmtSol(pnl.totalPnlSol)} / ${fmtSol(pnl.totalSizeSol)} SOL</b>`,
    `Gross win / loss: <b>+${fmtSol(pnl.grossWinSol)} / ${fmtSol(pnl.grossLossSol)} SOL</b>`,
    `Closed: <b>${pnl.count}</b> · Win: <b>${pnl.wins}</b> (${fmtPct(pnl.winRate)}) · Loss: <b>${pnl.losses}</b> (${fmtPct(pnl.lossRate)})${pnl.flats ? ` · Flat: <b>${pnl.flats}</b> (${fmtPct(pnl.flatRate)})` : ''}`,
    `Exit count: TP/Trail <b>${pnl.exitTp}</b> · SL <b>${pnl.exitSl}</b> · Max hold <b>${pnl.exitMaxHold}</b>${pnl.exitEarly ? ` · Early <b>${pnl.exitEarly}</b>` : ''}${manualOrOther ? ` · ${manualOrOther}` : ''}`,
  ];
}

function positionButtonLabel(position) {
  const symbol = position.symbol || short(position.mint);
  const pnl = position.pnl_percent != null ? ` ${fmtPct(position.pnl_percent)}` : '';
  return `${symbol} #${position.id}${pnl}`.slice(0, 60);
}

function maxHoldText(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return 'off';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (restSeconds) return `${minutes}m${restSeconds}s`;
  return formatDuration(value);
}

function onOff(value) {
  return value ? 'on' : 'off';
}

function cooldownLossPercent(strat) {
  const value = Number(strat.profit_cooldown_min_loss_percent ?? 17);
  return Number.isFinite(value) ? Math.abs(value) : 17;
}

function earlyLossExitPercent(strat) {
  const value = Number(strat.early_loss_exit_pnl_percent ?? -7);
  if (!Number.isFinite(value)) return -7;
  return value > 0 ? -value : value;
}

export function menuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Strategy', callback_data: 'menu:strategy' },
          { text: 'Active Strategy', callback_data: 'menu:active_strategy' },
          { text: 'Agent', callback_data: 'menu:agent' },
        ],
        [
          { text: 'Filters', callback_data: 'menu:filters' },
        ],
        [
          { text: 'History', callback_data: 'menu:history' },
          { text: 'Open Positions', callback_data: 'menu:positions' },
          { text: 'PnL', callback_data: 'menu:pnl' },
        ],
        [
          { text: 'Top Wins', callback_data: 'menu:topwins' },
          { text: 'Top Losses', callback_data: 'menu:toplosses' },
        ],
        [
          { text: 'Wallets', callback_data: 'menu:wallets' },
          { text: 'Close', callback_data: 'menu:close' },
        ],
      ],
    },
  };
}

export function filtersText() {
  const strat = activeStrategy();
  return [
    `⚙️ <b>Charon Filters</b> (${escapeHtml(strat.name)})`,
    `Min claim fee: ${fmtSol(strat.min_fee_claim_sol)} SOL`,
    `Min mcap: ${fmtUsd(strat.min_mcap_usd)}`,
    `Max mcap: ${strat.max_mcap_usd > 0 ? fmtUsd(strat.max_mcap_usd) : 'off'}`,
    `Min trading fees: ${fmtSol(strat.min_gmgn_total_fee_sol)} SOL`,
    `Min grad volume: ${fmtUsd(strat.min_graduated_volume_usd)}`,
    `Min holders: ${strat.min_holders || 'off'}`,
    `Max holder: ${strat.max_top20_holder_percent < 100 ? fmtPct(strat.max_top20_holder_percent) : 'off'}`,
    `Min saved holders: ${strat.min_saved_wallet_holders || 'off'}`,
    strat.max_ath_distance_pct < 0 ? `Max ATH distance: ${strat.max_ath_distance_pct}%` : null,
    '',
    `Source gate: ${onOff(strat.source_gate_enabled)} · req ${[
      strat.source_require_fee ? 'fee' : null,
      strat.source_require_graduated ? 'graduated' : null,
      strat.source_require_trending ? 'trending' : null,
    ].filter(Boolean).join('+') || 'none'} · fallback min src ${strat.min_source_count}`,
    `Fee required: ${strat.require_fee_claim ? 'yes' : 'no'}`,
    '',
    `Trending: <b>${boolSetting('trending_enabled', true) ? 'on' : 'off'}</b> · Source: <b>${escapeHtml(setting('trending_source', 'jupiter'))}</b>`,
    `GMGN status: token-info ${escapeHtml(gmgnStatusText('token'))} · trending ${escapeHtml(gmgnStatusText('trending'))}`,
    `Trending interval: ${escapeHtml(setting('trending_interval', '5m'))} · Limit: ${numSetting('trending_limit', 100)}`,
    `Min trend volume: ${fmtUsd(strat.trending_min_volume_usd)} · Min swaps: ${strat.trending_min_swaps}`,
    `Max trend rug: ${fmtPct(strat.trending_max_rug_ratio * 100)} · Max bundler: ${fmtPct(strat.trending_max_bundler_rate * 100)}`,
  ].filter(Boolean).join('\n');
}

export const numericFilterLabels = {
  min_fee_claim_sol: 'minimum creator fee-claim SOL',
  min_mcap_usd: 'minimum mcap USD',
  max_mcap_usd: 'maximum mcap USD',
  min_gmgn_total_fee_sol: 'minimum total trading fees SOL (GMGN)',
  min_graduated_volume_usd: 'minimum graduated volume USD',
  max_top20_holder_percent: 'maximum holder percent',
  min_saved_wallet_holders: 'minimum saved-wallet holders',
  trending_limit: 'trending result limit',
  trending_min_volume_usd: 'minimum trending volume USD',
  trending_min_swaps: 'minimum trending swaps',
  trending_max_rug_ratio: 'maximum trending rug ratio (0.3 = 30%)',
  trending_max_bundler_rate: 'maximum trending bundler rate (0.5 = 50%)',
};

export const strategyNumericLabels = {
  min_fee_claim_sol: 'minimum creator fee-claim SOL',
  min_mcap_usd: 'minimum mcap USD',
  max_mcap_usd: 'maximum mcap USD',
  min_gmgn_total_fee_sol: 'minimum total trading fees SOL (GMGN)',
  min_graduated_volume_usd: 'minimum graduated volume USD',
  min_holders: 'minimum holders',
  max_top20_holder_percent: 'maximum top holder percent',
  min_saved_wallet_holders: 'minimum saved-wallet holders',
  max_ath_distance_pct: 'maximum ATH distance percent (-40 = 40% below ATH, 0 = off)',
  min_source_count: 'minimum source count',
  token_age_max_ms: 'maximum token age milliseconds',
  trending_min_volume_usd: 'minimum trending volume USD',
  trending_min_swaps: 'minimum trending swaps',
  trending_max_rug_ratio: 'maximum trending rug ratio (0.3 = 30%)',
  trending_max_bundler_rate: 'maximum trending bundler rate (0.5 = 50%)',
  llm_min_confidence: 'LLM minimum confidence percent',
  position_size_sol: 'position size SOL',
  max_open_positions: 'maximum open positions',
  tp_percent: 'take profit percent',
  sl_percent: 'stop loss percent',
  trailing_percent: 'trailing percent',
  trailing_floor_at_percent: 'trailing floor trigger percent',
  trailing_floor_percent: 'trailing floor protected PnL percent',
  trailing_tier_1_at_percent: 'trailing tier 1 trigger percent',
  trailing_tier_1_percent: 'trailing tier 1 trailing percent',
  trailing_tier_2_at_percent: 'trailing tier 2 trigger percent',
  trailing_tier_2_percent: 'trailing tier 2 trailing percent',
  trailing_tier_3_at_percent: 'trailing tier 3 trigger percent',
  trailing_tier_3_percent: 'trailing tier 3 trailing percent',
  trailing_tier_4_at_percent: 'trailing tier 4 trigger percent',
  trailing_tier_4_percent: 'trailing tier 4 trailing percent',
  profit_cooldown_min_profit_percent: 'profit cooldown minimum profit percent',
  profit_cooldown_max_wins: 'profit cooldown allowed wins',
  profit_cooldown_min_loss_percent: 'profit cooldown minimum loss percent',
  profit_cooldown_max_losses: 'profit cooldown allowed losses',
  profit_cooldown_minutes: 'profit cooldown minutes',
  partial_tp_at_percent: 'partial TP trigger percent',
  partial_tp_sell_percent: 'partial TP sell percent',
  max_hold_ms: 'maximum hold time (examples: 45m, 1h30m, 2h, off)',
  early_exit_check_after_ms: 'early stagnation check time (examples: 90s, 1m30s, off)',
  early_exit_min_peak_pnl_percent: 'early stagnation minimum peak PnL percent',
  early_exit_max_current_pnl_percent: 'early stagnation maximum current PnL percent',
  early_loss_check_after_ms: 'early loss check time (examples: 60s, 1m, off)',
  early_loss_window_ms: 'early loss active window (examples: 3m, 5m, off)',
  early_loss_exit_pnl_percent: 'early loss exit PnL percent',
  sl_soft_percent: 'soft stop loss percent',
  sl_hard_percent: 'hard stop loss percent',
  sl_confirm_min_bad_signals: 'minimum bad signals for soft SL',
  sl_confirm_rsi_below: 'soft SL RSI confirmation threshold',
  sl_confirm_bb_below: 'soft SL Bollinger/BBRSI confirmation threshold',
  sl_confirm_buy_pressure_below: 'soft SL buy/sell confirmation threshold',
  supertrend_atr_period: 'Supertrend ATR period',
  supertrend_multiplier: 'Supertrend multiplier',
  rsi_period: 'RSI period',
  rsi_min: 'minimum RSI',
  rsi_max: 'maximum RSI',
  bbrsi_overbought_rsi: 'BBRSI overbought RSI',
  bbrsi_max_band_pos: 'BBRSI maximum band position percent',
  bb_buy_pressure_min_band_pos: 'BB buy-pressure minimum band position percent',
  bb_buy_pressure_min_ratio: 'BB buy-pressure minimum buy/sell ratio',
  buy_pressure_min_ratio: 'minimum buy/sell ratio',
  fresh_mcap_max_drop_percent: 'maximum fresh execution mcap drop percent',
  bb_period: 'Bollinger Band period',
  bb_stddev: 'Bollinger Band standard deviation',
};

export function filtersKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Configure in Strategy', callback_data: 'menu:strategy' }],
        [
          { text: 'Trend On/Off', callback_data: 'toggle:trending_enabled' },
          { text: 'Use Jupiter', callback_data: 'set:trending_source:jupiter' },
          { text: 'Use GMGN', callback_data: 'set:trending_source:gmgn' },
        ],
        [
          { text: 'Trend 5m', callback_data: 'set:trending_interval:5m' },
          { text: 'Trend 1h', callback_data: 'set:trending_interval:1h' },
          { text: 'Trend 6h', callback_data: 'set:trending_interval:6h' },
        ],
        [
          { text: 'Back', callback_data: 'menu:main' },
          { text: 'Close', callback_data: 'menu:close' },
        ],
      ],
    },
  };
}

export function agentText() {
  const strat = activeStrategy();
  const pnl = closedPnl();
  const pnlLine = pnl.count > 0
    ? `Closed PnL: ${pnl.count} trades · ${fmtPct(pnl.totalPnlPercent)} (${fmtSol(pnl.totalPnlSol)} SOL)`
    : 'Closed PnL: no closed trades';
  return [
    '🛶 <b>Charon Agent</b>',
    `Strategy: <b>${escapeHtml(strat.name)}</b>`,
    `Agent: <b>${boolSetting('agent_enabled', true) ? 'on' : 'off'}</b>`,
    `Mode: <b>${escapeHtml(tradingMode())}</b>`,
    `LLM: <b>${strat.use_llm && ENABLE_LLM && LLM_API_KEY ? 'configured' : 'disabled'}</b>`,
    `Confidence: ${fmtPct(strat.llm_min_confidence ?? 65)}`,
    `Open positions: ${openPositionCount()}/${strat.max_open_positions || 'unlimited'}`,
    `Batch candidates: ${numSetting('llm_candidate_pick_count', 10)}`,
    `Candidate freshness: ${Math.round(numSetting('llm_candidate_max_age_ms', 600000) / 1000)}s`,
    `Size: ${fmtSol(strat.position_size_sol)} SOL`,
    `TP/SL: ${fmtPct(strat.tp_percent)} / ${fmtPct(strat.sl_percent)}`,
    `SL confirmation: ${onOff(strat.sl_confirmation_enabled)} · soft ${fmtPct(strat.sl_soft_percent ?? strat.sl_percent)} · hard ${fmtPct(strat.sl_hard_percent ?? strat.sl_percent)} · bad ${strat.sl_confirm_min_bad_signals ?? 2}x`,
    `Early stagnation confirm: ${onOff(strat.early_exit_confirmation_enabled)} · uses SL bad-signal thresholds`,
    `Trailing: ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'off'}`,
    `Trail tiers: ${trailingTierText(strat)}`,
    `Profit cooldown: ${onOff(strat.profit_cooldown_enabled)} · mint · win ${strat.profit_cooldown_max_wins ?? 1}x >=${fmtPct(strat.profit_cooldown_min_profit_percent ?? 15)} · loss ${strat.profit_cooldown_max_losses ?? 2}x >=${fmtPct(cooldownLossPercent(strat))} / ${strat.profit_cooldown_minutes ?? 60}m`,
    `Max hold: ${maxHoldText(strat.max_hold_ms)}`,
    '',
    pnlLine,
  ].join('\n');
}

export function agentKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Toggle Agent', callback_data: 'toggle:agent' }],
        [
          { text: 'Dry Run', callback_data: 'set:trading_mode:dry_run' },
          { text: 'Confirm', callback_data: 'set:trading_mode:confirm' },
          { text: 'Live', callback_data: 'set:trading_mode:live' },
        ],
        [
          { text: 'Max Pos 1', callback_data: 'set:max_open_positions:1' },
          { text: 'Max Pos 3', callback_data: 'set:max_open_positions:3' },
          { text: 'Max Pos 5', callback_data: 'set:max_open_positions:5' },
        ],
        [
          { text: 'Batch 5', callback_data: 'set:llm_candidate_pick_count:5' },
          { text: 'Batch 10', callback_data: 'set:llm_candidate_pick_count:10' },
        ],
        [
          { text: 'Fresh 5m', callback_data: 'set:llm_candidate_max_age_ms:300000' },
          { text: 'Fresh 10m', callback_data: 'set:llm_candidate_max_age_ms:600000' },
          { text: 'Fresh 20m', callback_data: 'set:llm_candidate_max_age_ms:1200000' },
        ],
        [
          { text: 'Back', callback_data: 'menu:main' },
          { text: 'Close', callback_data: 'menu:close' },
        ],
      ],
    },
  };
}

export function navKeyboard(rows = []) {
  return {
    reply_markup: {
      inline_keyboard: [
        ...rows,
        [
          { text: 'Back', callback_data: 'menu:main' },
          { text: 'Close', callback_data: 'menu:close' },
        ],
      ],
    },
  };
}

export function mainMenuText() {
  const pnl = closedPnl();
  const today = closedPnl(todayWibBounds());
  return [
    '🛶 <b>Charon</b>',
    'Dry-run trench agent online.',
    '',
    ...pnlSummaryLines('Historical', pnl),
    'Formula: net PnL SOL ÷ total closed size SOL',
    '',
    '<b>Today WIB</b> (00:00-23:59)',
    ...pnlSummaryLines('Today', today),
    `Open positions: <b>${openPositionCount()}</b>`,
  ].join('\n');
}

export function activeStrategyJsonText() {
  const strat = activeStrategy();
  const row = db.prepare(`
    SELECT id, name, enabled, config_json
    FROM strategies
    WHERE id = ?
  `).get(strat.id);
  let config = {};
  try {
    config = JSON.parse(row?.config_json || '{}');
  } catch {
    config = {};
  }
  const payload = {
    id: row?.id || strat.id,
    name: row?.name || strat.name,
    enabled: Boolean(row?.enabled ?? true),
    ...config,
  };
  return [
    '🎯 <b>Active Strategy JSON</b>',
    '',
    `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`,
  ].join('\n');
}

export function walletsText() {
  const rows = savedWallets();
  const body = rows.length
    ? rows.map(row => `• <b>${escapeHtml(row.label)}</b>: <code>${escapeHtml(row.address)}</code>`).join('\n')
    : 'No saved wallets. Use /walletadd &lt;label&gt; &lt;address&gt;';
  return `👛 <b>Saved Wallets</b>\n\n${body}`;
}

export function cooldownText() {
  const strat = activeStrategy();
  return [
    '🧊 <b>Profit Cooldown</b>',
    '',
    `Strategy: <b>${escapeHtml(strat.name)}</b>`,
    `Status: <b>${onOff(strat.profit_cooldown_enabled)}</b>`,
    `Scope: <b>token mint</b>`,
    `Win trigger: <b>${strat.profit_cooldown_max_wins ?? 1}</b>x close >= <b>${fmtPct(strat.profit_cooldown_min_profit_percent ?? 15)}</b>`,
    `Loss trigger: <b>${strat.profit_cooldown_max_losses ?? 2}</b>x close loss >= <b>${fmtPct(cooldownLossPercent(strat))}</b>`,
    `Window: <b>${strat.profit_cooldown_minutes ?? 60}m</b>`,
    'Mode: hard filter before LLM and fresh execution check',
  ].join('\n');
}

export function cooldownKeyboard() {
  const strat = activeStrategy();
  return navKeyboard([
    [
      { text: `Profit CD ${onOff(strat.profit_cooldown_enabled)}`, callback_data: 'cooldowncfg:profit_cooldown_enabled' },
    ],
    [
      { text: `CD Profit ${fmtPct(strat.profit_cooldown_min_profit_percent ?? 15)}`, callback_data: 'cooldowninput:profit_cooldown_min_profit_percent' },
      { text: `CD Wins ${strat.profit_cooldown_max_wins ?? 1}`, callback_data: 'cooldowninput:profit_cooldown_max_wins' },
    ],
    [
      { text: `CD Loss ${fmtPct(cooldownLossPercent(strat))}`, callback_data: 'cooldowninput:profit_cooldown_min_loss_percent' },
      { text: `CD Losses ${strat.profit_cooldown_max_losses ?? 2}`, callback_data: 'cooldowninput:profit_cooldown_max_losses' },
    ],
    [
      { text: `CD Min ${strat.profit_cooldown_minutes ?? 60}m`, callback_data: 'cooldowninput:profit_cooldown_minutes' },
      { text: 'Strategy', callback_data: 'menu:strategy' },
    ],
  ]);
}

export function positionsText() {
  const rows = openPositions();
  const text = rows.length ? rows.map(formatPosition).join('\n\n') : 'No open positions.';
  return `📍 <b>Open Positions</b>\n\n${text}`;
}

export function openPositionsKeyboard() {
  const buttons = openPositions().map(position => ({
    text: positionButtonLabel(position),
    callback_data: `pos:${position.id}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return navKeyboard([
    [{ text: 'Refresh Open Positions', callback_data: 'positions:refresh' }],
    ...rows,
  ]);
}

export function closedHistoryText(limit = 10) {
  const rows = db.prepare(`
    SELECT id, mint, symbol, execution_mode, strategy_id, size_sol, pnl_percent, pnl_sol, exit_reason, closed_at_ms
    FROM dry_run_positions
    WHERE status = 'closed'
    ORDER BY COALESCE(closed_at_ms, opened_at_ms) DESC, id DESC
    LIMIT ?
  `).all(limit);
  if (!rows.length) return '📜 <b>Closed History</b>\n\nNo closed positions yet.';
  const wins = rows.filter(row => Number(row.pnl_percent || 0) > 0).length;
  const losses = rows.filter(row => Number(row.pnl_percent || 0) < 0).length;
  const flats = rows.length - wins - losses;
  const grossWinSol = rows.reduce((sum, row) => {
    const pnl = Number(row.pnl_sol || 0);
    return pnl > 0 ? sum + pnl : sum;
  }, 0);
  const grossLossSol = rows.reduce((sum, row) => {
    const pnl = Number(row.pnl_sol || 0);
    return pnl < 0 ? sum + pnl : sum;
  }, 0);
  const winRate = rows.length ? wins / rows.length * 100 : 0;
  const lossRate = rows.length ? losses / rows.length * 100 : 0;
  const flatRate = rows.length ? flats / rows.length * 100 : 0;
  const summary = [
    `Closed shown: <b>${rows.length}</b>`,
    `Win: <b>${wins}</b> (${fmtPct(winRate)})`,
    `Loss: <b>${losses}</b> (${fmtPct(lossRate)})`,
    flats ? `Flat: <b>${flats}</b> (${fmtPct(flatRate)})` : null,
  ].filter(Boolean).join(' · ');
  const solSummary = `Gross win / loss: <b>+${fmtSol(grossWinSol)} / ${fmtSol(grossLossSol)} SOL</b>`;
  const lines = rows.map((row, index) => {
    const pnlSol = Number(row.pnl_sol || 0);
    const sign = pnlSol > 0 ? '+' : '';
    const name = row.symbol || short(row.mint);
    return [
      `${index + 1}. <b>${escapeHtml(name)}</b> #${row.id}`,
      `${fmtPct(row.pnl_percent)} (${sign}${fmtSol(pnlSol)} SOL)`,
      escapeHtml(formatExitReason(row.exit_reason)),
      escapeHtml(row.strategy_id || row.execution_mode || ''),
    ].filter(Boolean).join(' · ');
  });
  return ['📜 <b>Last 10 Closed Positions</b>', summary, solSummary, '', ...lines].join('\n');
}

function rankedClosedText({ title, emptyText, order, comparison, limit = 5 }) {
  const rows = db.prepare(`
    SELECT id, mint, symbol, execution_mode, strategy_id, size_sol, pnl_percent, pnl_sol, exit_reason, closed_at_ms
    FROM dry_run_positions
    WHERE status = 'closed' AND pnl_percent ${comparison} 0
    ORDER BY pnl_percent ${order}, COALESCE(closed_at_ms, opened_at_ms) DESC, id DESC
    LIMIT ?
  `).all(limit);
  if (!rows.length) return `${title}\n\n${emptyText}`;
  const lines = rows.map((row, index) => {
    const pnlSol = Number(row.pnl_sol || 0);
    const sign = pnlSol > 0 ? '+' : '';
    const name = row.symbol || short(row.mint);
    return [
      `${index + 1}. <b>${escapeHtml(name)}</b> #${row.id}`,
      `${fmtPct(row.pnl_percent)} (${sign}${fmtSol(pnlSol)} SOL)`,
      escapeHtml(formatExitReason(row.exit_reason)),
      escapeHtml(row.strategy_id || row.execution_mode || ''),
    ].filter(Boolean).join(' · ');
  });
  return [title, '', ...lines].join('\n');
}

export function topWinsText(limit = 5) {
  return rankedClosedText({
    title: '🏆 <b>Top 5 Wins</b>',
    emptyText: 'No closed winning positions yet.',
    order: 'DESC',
    comparison: '>',
    limit,
  });
}

export function topLossesText(limit = 5) {
  return rankedClosedText({
    title: '🧯 <b>Top 5 Losses</b>',
    emptyText: 'No closed losing positions yet.',
    order: 'ASC',
    comparison: '<',
    limit,
  });
}

export function strategyMenuText() {
  const strat = activeStrategy();
  const all = allStrategies();
  const entryIcons = { immediate: '⚡', wait_for_dip: '📉', after_confirmation: '🧠' };
  return [
    '🎯 <b>Strategy</b>',
    '',
    `Active: <b>${escapeHtml(strat.name)}</b>`,
    `Entry: ${entryIcons[strat.entry_mode] || '?'} ${strat.entry_mode}`,
    `Source gate: ${onOff(strat.source_gate_enabled)} · req ${[
      strat.source_require_fee ? 'fee' : null,
      strat.source_require_graduated ? 'graduated' : null,
      strat.source_require_trending ? 'trending' : null,
    ].filter(Boolean).join('+') || 'none'} · fallback min src ${strat.min_source_count}`,
    `Fee required: ${strat.require_fee_claim ? 'yes' : 'no'}`,
    `Size: ${fmtSol(strat.position_size_sol)} SOL`,
    `TP/SL: ${fmtPct(strat.tp_percent)} / ${fmtPct(strat.sl_percent)}`,
    `Trailing: ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'off'}`,
    `Trail tiers: ${trailingTierText(strat)}`,
    `Profit cooldown: ${onOff(strat.profit_cooldown_enabled)} · mint · win ${strat.profit_cooldown_max_wins ?? 1}x >=${fmtPct(strat.profit_cooldown_min_profit_percent ?? 15)} · loss ${strat.profit_cooldown_max_losses ?? 2}x >=${fmtPct(cooldownLossPercent(strat))} / ${strat.profit_cooldown_minutes ?? 60}m`,
    `Max hold: ${maxHoldText(strat.max_hold_ms)}`,
    `Early stagnation: ${onOff(strat.early_exit_enabled)} · confirm ${onOff(strat.early_exit_confirmation_enabled)} · after ${maxHoldText(strat.early_exit_check_after_ms)} · peak &lt; ${fmtPct(strat.early_exit_min_peak_pnl_percent ?? 5)} · current &lt;= ${fmtPct(strat.early_exit_max_current_pnl_percent ?? 0)}`,
    `Early weakness: ${onOff(strat.early_loss_guard_enabled)} · after ${maxHoldText(strat.early_loss_check_after_ms)} · window ${maxHoldText(strat.early_loss_window_ms)} · current &lt;= ${fmtPct(earlyLossExitPercent(strat))}`,
    `Indicators: ${onOff(strat.chart_indicators_enabled)} · Hard: ${onOff(strat.chart_indicators_hard_filter)} · TF: ${strat.indicator_timeframe || '1m'} · ST req: ${onOff(strat.supertrend_required)} · RSI: ${onOff(strat.rsi_guard_enabled)} ${strat.rsi_min ?? 45}-${strat.rsi_max ?? 78} / P${strat.rsi_period ?? 14}`,
    `BBRSI: ${onOff(strat.bbrsi_guard_enabled)} · Overheat: RSI ${strat.bbrsi_overbought_rsi ?? strat.rsi_max ?? 78} / BB ${fmtPct(strat.bbrsi_max_band_pos ?? 105)}`,
    `BB Buy Pressure: ${onOff(strat.bb_buy_pressure_guard_enabled)} · BB >= ${fmtPct(strat.bb_buy_pressure_min_band_pos ?? 80)} needs B/S > ${strat.bb_buy_pressure_min_ratio ?? 1.5}`,
    `Buy Pressure: ${onOff(strat.buy_pressure_guard_enabled)} · B/S > ${strat.buy_pressure_min_ratio ?? 0}`,
    `Fresh dump guard: ${onOff(strat.fresh_mcap_dump_guard_enabled)} · max drop ${fmtPct(strat.fresh_mcap_max_drop_percent ?? 0)}`,
    `Max positions: ${strat.max_open_positions}`,
    strat.min_holders > 0 ? `Min holders: ${strat.min_holders}` : null,
    strat.max_ath_distance_pct < 0 ? `Max ATH distance: ${strat.max_ath_distance_pct}%` : null,
    strat.partial_tp ? `Partial TP: ${strat.partial_tp_sell_percent}% at ${fmtPct(strat.partial_tp_at_percent)}` : null,
    strat.use_llm ? `LLM: yes (min ${strat.llm_min_confidence ?? 65}%)` : 'LLM: no (rule-based)',
    '',
    ...all.map(s => `${s.enabled ? '▶' : '○'} ${s.name}`),
  ].filter(Boolean).join('\n');
}

export function strategyKeyboard() {
  const strat = activeStrategy();
  const all = allStrategies();
  const selector = all.map(s => [{
    text: `${s.enabled ? '▶ ' : ''}${s.name}`,
    callback_data: `strategy:select:${s.id}`,
  }]);
  const config = [
    [
      { text: `TP +${strat.tp_percent}%`, callback_data: 'stratinput:tp_percent' },
      { text: `SL ${strat.sl_percent}%`, callback_data: 'stratinput:sl_percent' },
    ],
    [
      { text: `SL Conf ${onOff(strat.sl_confirmation_enabled)}`, callback_data: 'stratcfg:sl_confirmation_enabled' },
      { text: `Soft ${fmtPct(strat.sl_soft_percent ?? strat.sl_percent)}`, callback_data: 'stratinput:sl_soft_percent' },
    ],
    [
      { text: `Hard ${fmtPct(strat.sl_hard_percent ?? strat.sl_percent)}`, callback_data: 'stratinput:sl_hard_percent' },
      { text: `Bad Sig ${strat.sl_confirm_min_bad_signals ?? 2}`, callback_data: 'stratinput:sl_confirm_min_bad_signals' },
    ],
    [
      { text: `SL RSI ${strat.sl_confirm_rsi_below ?? 38}`, callback_data: 'stratinput:sl_confirm_rsi_below' },
      { text: `SL BB ${strat.sl_confirm_bb_below ?? 25}`, callback_data: 'stratinput:sl_confirm_bb_below' },
    ],
    [
      { text: `SL B/S ${strat.sl_confirm_buy_pressure_below ?? 0.8}`, callback_data: 'stratinput:sl_confirm_buy_pressure_below' },
      { text: `SL ST ${onOff(strat.sl_confirm_supertrend_bearish ?? true)}`, callback_data: 'stratcfg:sl_confirm_supertrend_bearish' },
    ],
    [
      { text: `Size ${strat.position_size_sol} SOL`, callback_data: 'stratinput:position_size_sol' },
      { text: `Max Pos ${strat.max_open_positions}`, callback_data: 'stratinput:max_open_positions' },
    ],
    [
      { text: `Min Mcap ${strat.min_mcap_usd > 0 ? fmtUsd(strat.min_mcap_usd) : 'off'}`, callback_data: 'stratinput:min_mcap_usd' },
      { text: `Max Mcap ${strat.max_mcap_usd > 0 ? fmtUsd(strat.max_mcap_usd) : 'off'}`, callback_data: 'stratinput:max_mcap_usd' },
    ],
    [
      { text: `Trail ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'off'}`, callback_data: 'stratinput:trailing_percent' },
      { text: `Min Src ${strat.min_source_count}`, callback_data: 'stratinput:min_source_count' },
    ],
    [
      { text: `Src Gate ${onOff(strat.source_gate_enabled)}`, callback_data: 'stratcfg:source_gate_enabled' },
      { text: `Src Fee ${onOff(strat.source_require_fee)}`, callback_data: 'stratcfg:source_require_fee' },
    ],
    [
      { text: `Src Grad ${onOff(strat.source_require_graduated)}`, callback_data: 'stratcfg:source_require_graduated' },
      { text: `Src Trend ${onOff(strat.source_require_trending)}`, callback_data: 'stratcfg:source_require_trending' },
    ],
    [
      { text: `Trail Tiers ${onOff(strat.trailing_tiers_enabled)}`, callback_data: 'stratcfg:trailing_tiers_enabled' },
    ],
    [
      { text: `Profit CD ${onOff(strat.profit_cooldown_enabled)}`, callback_data: 'stratcfg:profit_cooldown_enabled' },
      { text: `CD Profit ${fmtPct(strat.profit_cooldown_min_profit_percent ?? 5)}`, callback_data: 'stratinput:profit_cooldown_min_profit_percent' },
    ],
    [
      { text: `CD Wins ${strat.profit_cooldown_max_wins ?? 1}`, callback_data: 'stratinput:profit_cooldown_max_wins' },
      { text: `CD Min ${strat.profit_cooldown_minutes ?? 60}m`, callback_data: 'stratinput:profit_cooldown_minutes' },
    ],
    [
      { text: `CD Loss ${fmtPct(cooldownLossPercent(strat))}`, callback_data: 'stratinput:profit_cooldown_min_loss_percent' },
      { text: `CD Losses ${strat.profit_cooldown_max_losses ?? 2}`, callback_data: 'stratinput:profit_cooldown_max_losses' },
    ],
    [
      { text: `Floor At ${fmtPct(strat.trailing_floor_at_percent ?? 10)}`, callback_data: 'stratinput:trailing_floor_at_percent' },
      { text: `Floor ${fmtPct(strat.trailing_floor_percent ?? 5)}`, callback_data: 'stratinput:trailing_floor_percent' },
    ],
    [
      { text: `T1 At ${fmtPct(strat.trailing_tier_1_at_percent ?? 20)}`, callback_data: 'stratinput:trailing_tier_1_at_percent' },
      { text: `T1 Trail ${fmtPct(strat.trailing_tier_1_percent ?? 10)}`, callback_data: 'stratinput:trailing_tier_1_percent' },
    ],
    [
      { text: `T2 At ${fmtPct(strat.trailing_tier_2_at_percent ?? 30)}`, callback_data: 'stratinput:trailing_tier_2_at_percent' },
      { text: `T2 Trail ${fmtPct(strat.trailing_tier_2_percent ?? 15)}`, callback_data: 'stratinput:trailing_tier_2_percent' },
    ],
    [
      { text: `T3 At ${fmtPct(strat.trailing_tier_3_at_percent ?? 60)}`, callback_data: 'stratinput:trailing_tier_3_at_percent' },
      { text: `T3 Trail ${fmtPct(strat.trailing_tier_3_percent ?? 20)}`, callback_data: 'stratinput:trailing_tier_3_percent' },
    ],
    [
      { text: `T4 At ${fmtPct(strat.trailing_tier_4_at_percent ?? 100)}`, callback_data: 'stratinput:trailing_tier_4_at_percent' },
      { text: `T4 Trail ${fmtPct(strat.trailing_tier_4_percent ?? 30)}`, callback_data: 'stratinput:trailing_tier_4_percent' },
    ],
    [
      { text: `Fee Req ${strat.require_fee_claim ? 'on' : 'off'}`, callback_data: 'stratcfg:require_fee_claim' },
      { text: `LLM ${strat.use_llm ? 'on' : 'off'}`, callback_data: 'stratcfg:use_llm' },
    ],
    [
      { text: `Min Holders ${strat.min_holders}`, callback_data: 'stratinput:min_holders' },
      { text: `Conf ${strat.llm_min_confidence}%`, callback_data: 'stratinput:llm_min_confidence' },
    ],
    [
      { text: `Partial TP ${strat.partial_tp ? 'on' : 'off'}`, callback_data: 'stratcfg:partial_tp' },
      { text: `Max Hold ${maxHoldText(strat.max_hold_ms)}`, callback_data: 'stratinput:max_hold_ms' },
    ],
    [
      { text: `Early Stag ${onOff(strat.early_exit_enabled)}`, callback_data: 'stratcfg:early_exit_enabled' },
      { text: `Stag Conf ${onOff(strat.early_exit_confirmation_enabled)}`, callback_data: 'stratcfg:early_exit_confirmation_enabled' },
    ],
    [
      { text: `Stag After ${maxHoldText(strat.early_exit_check_after_ms ?? 90000)}`, callback_data: 'stratinput:early_exit_check_after_ms' },
      { text: `Stag Peak ${fmtPct(strat.early_exit_min_peak_pnl_percent ?? 5)}`, callback_data: 'stratinput:early_exit_min_peak_pnl_percent' },
    ],
    [
      { text: `Stag Cur ${fmtPct(strat.early_exit_max_current_pnl_percent ?? 0)}`, callback_data: 'stratinput:early_exit_max_current_pnl_percent' },
    ],
    [
      { text: `Early Loss ${onOff(strat.early_loss_guard_enabled)}`, callback_data: 'stratcfg:early_loss_guard_enabled' },
      { text: `Loss After ${maxHoldText(strat.early_loss_check_after_ms ?? 60000)}`, callback_data: 'stratinput:early_loss_check_after_ms' },
    ],
    [
      { text: `Loss Exit ${fmtPct(earlyLossExitPercent(strat))}`, callback_data: 'stratinput:early_loss_exit_pnl_percent' },
      { text: `Loss Window ${maxHoldText(strat.early_loss_window_ms ?? 0)}`, callback_data: 'stratinput:early_loss_window_ms' },
    ],
    [
      { text: `Claim Fee ${fmtSol(strat.min_fee_claim_sol)} SOL`, callback_data: 'stratinput:min_fee_claim_sol' },
      { text: `Trading Fees ${fmtSol(strat.min_gmgn_total_fee_sol)} SOL`, callback_data: 'stratinput:min_gmgn_total_fee_sol' },
    ],
    [
      { text: `Grad Vol ${fmtUsd(strat.min_graduated_volume_usd)}`, callback_data: 'stratinput:min_graduated_volume_usd' },
      { text: `Max Holder ${strat.max_top20_holder_percent < 100 ? fmtPct(strat.max_top20_holder_percent) : 'off'}`, callback_data: 'stratinput:max_top20_holder_percent' },
    ],
    [
      { text: `Saved ${strat.min_saved_wallet_holders || 'off'}`, callback_data: 'stratinput:min_saved_wallet_holders' },
      { text: `ATH ${strat.max_ath_distance_pct < 0 ? `${strat.max_ath_distance_pct}%` : 'off'}`, callback_data: 'stratinput:max_ath_distance_pct' },
    ],
    [
      { text: `Age ${strat.token_age_max_ms > 0 ? Math.round(strat.token_age_max_ms / 60000) + 'm' : 'off'}`, callback_data: 'stratinput:token_age_max_ms' },
      { text: `Trend Vol ${fmtUsd(strat.trending_min_volume_usd)}`, callback_data: 'stratinput:trending_min_volume_usd' },
    ],
    [
      { text: `Trend Swaps ${strat.trending_min_swaps}`, callback_data: 'stratinput:trending_min_swaps' },
      { text: `Max Rug ${fmtPct(strat.trending_max_rug_ratio * 100)}`, callback_data: 'stratinput:trending_max_rug_ratio' },
    ],
    [
      { text: `Max Bundler ${fmtPct(strat.trending_max_bundler_rate * 100)}`, callback_data: 'stratinput:trending_max_bundler_rate' },
      { text: `Partial Sell ${strat.partial_tp_sell_percent}%`, callback_data: 'stratinput:partial_tp_sell_percent' },
    ],
    [
      { text: `Partial At ${strat.partial_tp_at_percent}%`, callback_data: 'stratinput:partial_tp_at_percent' },
    ],
    [
      { text: `Chart Ind ${onOff(strat.chart_indicators_enabled)}`, callback_data: 'stratcfg:chart_indicators_enabled' },
      { text: `Chart Hard ${onOff(strat.chart_indicators_hard_filter)}`, callback_data: 'stratcfg:chart_indicators_hard_filter' },
    ],
    [
      { text: `Ind TF ${strat.indicator_timeframe || '1m'}`, callback_data: 'stratcfg:indicator_timeframe' },
    ],
    [
      { text: `ST Req ${onOff(strat.supertrend_required)}`, callback_data: 'stratcfg:supertrend_required' },
      { text: `RSI Guard ${onOff(strat.rsi_guard_enabled)}`, callback_data: 'stratcfg:rsi_guard_enabled' },
    ],
    [
      { text: `RSI Per ${strat.rsi_period ?? 14}`, callback_data: 'stratinput:rsi_period' },
      { text: `RSI Min ${strat.rsi_min ?? 45}`, callback_data: 'stratinput:rsi_min' },
    ],
    [
      { text: `RSI Max ${strat.rsi_max ?? 78}`, callback_data: 'stratinput:rsi_max' },
    ],
    [
      { text: `BBRSI ${onOff(strat.bbrsi_guard_enabled)}`, callback_data: 'stratcfg:bbrsi_guard_enabled' },
      { text: `BBRSI RSI ${strat.bbrsi_overbought_rsi ?? strat.rsi_max ?? 78}`, callback_data: 'stratinput:bbrsi_overbought_rsi' },
    ],
    [
      { text: `BB Max ${fmtPct(strat.bbrsi_max_band_pos ?? 105)}`, callback_data: 'stratinput:bbrsi_max_band_pos' },
    ],
    [
      { text: `BB BuyP ${onOff(strat.bb_buy_pressure_guard_enabled)}`, callback_data: 'stratcfg:bb_buy_pressure_guard_enabled' },
      { text: `BB BP At ${fmtPct(strat.bb_buy_pressure_min_band_pos ?? 80)}`, callback_data: 'stratinput:bb_buy_pressure_min_band_pos' },
    ],
    [
      { text: `BB BP Ratio ${strat.bb_buy_pressure_min_ratio ?? 1.5}`, callback_data: 'stratinput:bb_buy_pressure_min_ratio' },
    ],
    [
      { text: `BuyP ${onOff(strat.buy_pressure_guard_enabled)}`, callback_data: 'stratcfg:buy_pressure_guard_enabled' },
      { text: `BuyP Ratio ${strat.buy_pressure_min_ratio ?? 0}`, callback_data: 'stratinput:buy_pressure_min_ratio' },
    ],
    [
      { text: `Fresh Dump ${onOff(strat.fresh_mcap_dump_guard_enabled)}`, callback_data: 'stratcfg:fresh_mcap_dump_guard_enabled' },
      { text: `Fresh Drop ${fmtPct(strat.fresh_mcap_max_drop_percent ?? 0)}`, callback_data: 'stratinput:fresh_mcap_max_drop_percent' },
    ],
    [
      { text: `ST Per ${strat.supertrend_atr_period ?? 10}`, callback_data: 'stratinput:supertrend_atr_period' },
      { text: `ST Mult ${strat.supertrend_multiplier ?? 3}`, callback_data: 'stratinput:supertrend_multiplier' },
    ],
    [
      { text: `BB Per ${strat.bb_period ?? 20}`, callback_data: 'stratinput:bb_period' },
      { text: `BB Dev ${strat.bb_stddev ?? 2}`, callback_data: 'stratinput:bb_stddev' },
    ],
  ];
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '── Select Strategy ──', callback_data: 'noop' }],
        ...selector,
        [{ text: '── Configure ──', callback_data: 'noop' }],
        ...config,
        [
          { text: 'Back', callback_data: 'menu:main' },
          { text: 'Close', callback_data: 'menu:close' },
        ],
      ],
    },
  };
}

export function candidateButtons(candidateId, decision = null) {
  const verdict = String(decision?.verdict || '').toUpperCase();
  if (verdict && verdict !== 'BUY') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: `Skipped: ${verdict}`, callback_data: 'noop' }],
          [
            { text: 'View Candidate', callback_data: `cand:${candidateId}` },
            { text: 'Ignore', callback_data: `ign:${candidateId}` },
          ],
          [{ text: 'Open Positions', callback_data: 'menu:positions' }],
        ],
      },
    };
  }
  if (verdict === 'BUY') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'LLM BUY selected', callback_data: 'noop' }],
          [
            { text: 'View Candidate', callback_data: `cand:${candidateId}` },
            { text: 'Open Positions', callback_data: 'menu:positions' },
          ],
          [
            { text: 'Set TP/SL', callback_data: `tpsl:c:${candidateId}` },
            { text: 'Ignore', callback_data: `ign:${candidateId}` },
          ],
        ],
      },
    };
  }
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'View Candidate', callback_data: `cand:${candidateId}` },
          { text: 'Dry Buy', callback_data: `buy:${candidateId}` },
        ],
        [
          { text: 'Set TP/SL', callback_data: `tpsl:c:${candidateId}` },
          { text: 'Ignore', callback_data: `ign:${candidateId}` },
        ],
        [{ text: 'Open Positions', callback_data: 'menu:positions' }],
      ],
    },
  };
}

export function batchRevealButtons(batchId, rows, decision, triggerCandidateId = null) {
  const selectedId = Number(decision.selected_candidate_id || 0);
  const triggerId = Number(triggerCandidateId || 0);
  const keyboard = [];
  if (selectedId) keyboard.push([{ text: 'Reveal Pick', callback_data: `cand:${selectedId}` }]);
  keyboard.push([{ text: 'Reveal Batch', callback_data: `batch:${batchId}` }]);
  if (triggerId && triggerId !== selectedId) keyboard.push([{ text: 'Reveal Trigger', callback_data: `cand:${triggerId}` }]);
  keyboard.push([{ text: 'Open Positions', callback_data: 'menu:positions' }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

export function positionButtons(positionId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Dry Stop', callback_data: `sell:${positionId}` },
          { text: 'Refresh', callback_data: `pos:${positionId}` },
        ],
        [
          { text: 'TP +25%', callback_data: `tp:${positionId}:25` },
          { text: 'TP +50%', callback_data: `tp:${positionId}:50` },
        ],
        [
          { text: 'SL -15%', callback_data: `sl:${positionId}:-15` },
          { text: 'SL -25%', callback_data: `sl:${positionId}:-25` },
        ],
        [{ text: 'Trail On/Off', callback_data: `trail:${positionId}` }],
        [
          { text: 'Open Positions', callback_data: 'menu:positions' },
          { text: 'Back', callback_data: 'menu:main' },
          { text: 'Close', callback_data: 'menu:close' },
        ],
      ],
    },
  };
}

export function intentButtons(intentId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Confirm Buy', callback_data: `intent:${intentId}:confirm` },
          { text: 'Reject', callback_data: `intent:${intentId}:reject` },
        ],
        [{ text: 'Open Positions', callback_data: 'menu:positions' }],
      ],
    },
  };
}

export async function sendTpSlDefaults(chatId, query = null) {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Default TP +25%', callback_data: 'set:default_tp_percent:25' },
          { text: 'Default TP +50%', callback_data: 'set:default_tp_percent:50' },
        ],
        [
          { text: 'Default SL -15%', callback_data: 'set:default_sl_percent:-15' },
          { text: 'Default SL -25%', callback_data: 'set:default_sl_percent:-25' },
        ],
        [
          { text: 'Trail On', callback_data: 'set:default_trailing_enabled:true' },
          { text: 'Trail Off', callback_data: 'set:default_trailing_enabled:false' },
        ],
        [
          { text: 'Back', callback_data: 'menu:main' },
          { text: 'Close', callback_data: 'menu:close' },
        ],
      ],
    },
  };
  if (query) return editMenuMessage(query, agentText(), keyboard);
  const { bot } = await import('./bot.js');
  await bot.sendMessage(chatId, agentText(), { parse_mode: 'HTML', ...keyboard });
}

async function editMenuMessage(query, text, extra = {}) {
  const { TELEGRAM_CHAT_ID } = await import('../config.js');
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  const { bot } = await import('./bot.js');
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
