import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink, txLink, accountLink } from '../format.js';
import { formatDuration, now, safeJson } from '../utils.js';
import { strategyById } from '../db/settings.js';
import { effectiveTrailingPercent, trailingTierText } from '../execution/trailing.js';
import { db } from '../db/connection.js';

function positionHoldLine(position) {
  const openedAt = Number(position.opened_at_ms || 0);
  if (!openedAt) return null;
  const closedAt = Number(position.closed_at_ms || 0);
  const endAt = position.status === 'closed' && closedAt > 0 ? closedAt : now();
  const heldMs = Math.max(0, endAt - openedAt);
  const directMaxHold = Number(position.max_hold_ms);
  const strategyMaxHold = Number(strategyById(position.strategy_id)?.max_hold_ms || 0);
  const maxHoldMs = Number.isFinite(directMaxHold) && directMaxHold > 0 ? directMaxHold : strategyMaxHold;
  const maxHoldText = maxHoldMs > 0 ? formatDuration(maxHoldMs) : 'off';
  return `Hold: ${formatDuration(heldMs)} · Max hold: ${maxHoldText}`;
}

export function formatExitReason(reason, context = {}) {
  const raw = String(reason || '').trim();
  if (raw === 'TRAILING_TP' && context.floorPercent != null) {
    return `floor ${fmtPct(context.floorPercent)} TP`;
  }
  if (raw === 'TRAILING_TP' && context.trailingPercent != null) {
    return `trailing ${fmtPct(context.trailingPercent)} TP`;
  }
  const labels = {
    MAX_HOLD: 'max hold time',
    EARLY_STAGNATION: 'early stagnation',
    EARLY_WEAKNESS: 'early weakness',
    TRAILING_TP: 'trailing TP',
    PARTIAL_TP: 'partial TP',
    SOFT_SL: 'indicator SL',
    HARD_SL: 'hard SL',
    SL: 'SL',
  };
  return labels[raw] || raw || 'closed';
}

function exitTradeContext(position) {
  if (!position?.id || !position.exit_reason) return {};
  const row = db.prepare(`
    SELECT payload_json
    FROM dry_run_trades
    WHERE position_id = ? AND side = 'sell' AND reason = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(position.id, position.exit_reason);
  const payload = safeJson(row?.payload_json, {}) || {};
  return {
    trailingPercent: payload.trailingPercent,
    floorPercent: payload.floorPercent,
    floorAtPercent: payload.floorAtPercent,
    trailDrop: payload.trailDrop,
    highWaterPnlPercent: payload.highWaterPnlPercent,
    slConfirmation: payload.slConfirmation,
    earlyStagnationConfirmation: payload.earlyStagnationConfirmation,
  };
}

export function formatRecipients(shareholders) {
  if (!shareholders?.length) return '';
  return shareholders.slice(0, 5).map((holder, index) => {
    const pct = holder.bps != null ? ` (${fmtPct(holder.bps / 100)})` : '';
    const label = shareholders.length > 1 ? `Recipient ${index + 1}` : 'Recipient';
    return `${label}: <a href="${accountLink(holder.pubkey)}">${short(holder.pubkey)}</a>${pct}`;
  }).join('\n') + '\n';
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

function formatIndicatorSummary(indicators) {
  if (!indicators?.available) return null;
  const parts = [];
  if (indicators.supertrend?.trend) {
    parts.push(`ST: ${escapeHtml(indicators.supertrend.trend)}${indicators.supertrend.distancePercent == null ? '' : ` ${fmtPct(indicators.supertrend.distancePercent)}`}`);
  }
  if (indicators.rsi?.value != null) parts.push(`RSI: ${Number(indicators.rsi.value).toFixed(1)}`);
  if (indicators.bollinger?.bandPosition != null) parts.push(`BB: ${fmtPct(indicators.bollinger.bandPosition)}`);
  if (indicators.bbrsi?.overbought) parts.push('BBRSI: overbought');
  if (indicators.bbrsi?.oversold) parts.push('BBRSI: oversold');
  if (parts.length) return `Ind ${escapeHtml(indicators.timeframe || '')}: ${parts.join(' · ')}`.trim();
  const required = Math.max(0, ...Object.values(indicators.warmup?.requiredCandles || {}).map(Number));
  if (required > 0) return `Ind ${escapeHtml(indicators.timeframe || '')}: warming ${indicators.candleCount}/${required} candles`;
  return null;
}

export function candidateSummary(candidate, decision = null) {
  const chartWindow = candidate.chart?.windows?.find(row => row.label === 'ath_context_24h_5m' && row.available)
    || candidate.chart?.windows?.find(row => row.label === 'recent_24h_5m' && row.available);
  const route = candidate.signals?.label || signalLabel(candidate.signals);
  const lines = [
    `🛶 <b>Charon Candidate</b>`,
    '',
    `Signal: <b>${escapeHtml(route)}</b>`,
    candidate.token.name || candidate.token.symbol ? `Name: <b>${escapeHtml(candidate.token.name || candidate.token.symbol)}${candidate.token.symbol && candidate.token.name ? ` (${escapeHtml(candidate.token.symbol)})` : ''}</b>` : null,
    `Token: <a href="${gmgnLink(candidate.token.mint)}">${short(candidate.token.mint)}</a>`,
    `<code>${escapeHtml(candidate.token.mint)}</code>`,
    [
      `Mcap: ${fmtUsd(candidate.metrics.marketCapUsd)}`,
      `Liq: ${fmtUsd(candidate.metrics.liquidityUsd)}`,
      `Fees: ${fmtSol(candidate.metrics.gmgnTotalFeesSol)} SOL`,
      `Grad vol: ${fmtUsd(candidate.metrics.graduatedVolumeUsd)}`,
    ].join(' · '),
    [
      `Holders: ${candidate.metrics.holderCount || '?'}`,
      `Top20: ${fmtPct(candidate.holders.top20Percent)}`,
      `Max holder: ${fmtPct(candidate.holders.maxHolderPercent)}`,
      `Saved wallets: ${candidate.savedWalletExposure.holderCount}/${candidate.savedWalletExposure.checked}`,
    ].join(' · '),
    candidate.trending ? [
      `Trending: #${candidate.trending.rank || '?'}/${escapeHtml(candidate.trending.interval || '')}`,
      `Vol: ${fmtUsd(candidate.metrics.trendingVolumeUsd)}`,
      `Swaps: ${candidate.metrics.trendingSwaps || 0}`,
      `Hot: ${candidate.metrics.trendingHotLevel || 0}`,
      `Smart: ${candidate.metrics.trendingSmartDegenCount || 0}`,
    ].join(' · ') : null,
    chartWindow ? [
      `ATH ctx: ${fmtPct(chartWindow.belowHighPercent)} from 24h high`,
      `Range low: ${fmtPct(chartWindow.aboveLowPercent)}`,
      `Top risk: ${candidate.chart.topBlastRisk ? 'yes' : 'no'}`,
    ].join(' · ') : null,
    formatIndicatorSummary(candidate.chart?.indicators),
    candidate.twitterNarrative?.metrics ? [
      `Tweet: ${candidate.twitterNarrative.metrics.likes} likes`,
      `${candidate.twitterNarrative.metrics.retweets} RT`,
      `${candidate.twitterNarrative.metrics.replies} replies`,
      `${candidate.twitterNarrative.metrics.quotes} quotes`,
    ].join(' · ') : null,
    candidate.feeClaim ? `Fee claim: <b>${fmtSol(candidate.feeClaim.distributedSol)} SOL</b>` : null,
    candidate.twitterNarrative?.text ? `Narrative: ${escapeHtml(candidate.twitterNarrative.text.slice(0, 220))}` : null,
    decision ? `LLM: <b>${escapeHtml(decision.verdict)}</b> ${fmtPct(decision.confidence)} — ${escapeHtml(decision.reason || '')}` : null,
    candidate.filters.passed ? null : `Filtered: ${escapeHtml(candidate.filters.failures.join('; '))}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function compactCandidateLine(row, index = null) {
  const candidate = row.candidate;
  const prefix = index == null ? '' : `${index}. `;
  const name = candidate.token?.symbol || candidate.token?.name || short(candidate.token?.mint || '');
  const signal = candidate.signals?.label || signalLabel(candidate.signals);
  return [
    `${prefix}<b>${escapeHtml(name)}</b>`,
    `<a href="${gmgnLink(candidate.token.mint)}">${short(candidate.token.mint)}</a>`,
    escapeHtml(signal),
    `mcap ${fmtUsd(candidate.metrics?.marketCapUsd)}`,
    `liq ${fmtUsd(candidate.metrics?.liquidityUsd)}`,
    candidate.feeClaim ? `fee ${fmtSol(candidate.feeClaim.distributedSol)} SOL` : null,
  ].filter(Boolean).join(' · ');
}

export function batchRevealSummary(batchId, rows, decision, triggerCandidateId = null) {
  const selected = rows.find(row => row.id === Number(decision.selected_candidate_id));
  const trigger = rows.find(row => row.id === Number(triggerCandidateId));
  const lines = [
    '🧭 <b>Charon Screening</b>',
    '',
    `Batch: <b>#${batchId}</b> · Screened: <b>${rows.length}</b>`,
    trigger ? `Trigger: ${compactCandidateLine(trigger)}` : null,
    selected ? `Pick: ${compactCandidateLine(selected)}` : 'Pick: <b>none</b>',
    `Decision: <b>${escapeHtml(decision.verdict || 'WATCH')}</b> ${fmtPct(decision.confidence || 0)}`,
    decision.reason ? `Reason: ${escapeHtml(String(decision.reason).slice(0, 420))}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

export function formatPosition(position) {
  const pnl = position.pnl_percent != null
    ? Number(position.pnl_percent)
    : position.entry_mcap && position.high_water_mcap
      ? (Number(position.high_water_mcap) / Number(position.entry_mcap) - 1) * 100
      : 0;
  const peakPnl = position.entry_mcap && position.high_water_mcap
    ? (Number(position.high_water_mcap) / Number(position.entry_mcap) - 1) * 100
    : pnl;
  const entryMcap = Number(position.entry_mcap);
  const liveMcap = Number(position.mcap);
  const exitMcap = Number(position.exit_mcap);
  const estimatedCurrentMcap = Number.isFinite(entryMcap) && entryMcap > 0 && Number.isFinite(pnl)
    ? entryMcap * (1 + pnl / 100)
    : null;
  const currentMcap = Number.isFinite(liveMcap) && liveMcap > 0
    ? liveMcap
    : position.status === 'closed' && Number.isFinite(exitMcap) && exitMcap > 0
      ? exitMcap
      : estimatedCurrentMcap;
  const currentMcapLabel = position.status === 'closed' ? 'Exit mcap' : 'Current mcap';
  const strat = strategyById(position.strategy_id);
  const activeTrail = position.trailing_enabled
    ? effectiveTrailingPercent(position, strat || {}, peakPnl)
    : null;
  if (position.trailing_enabled && activeTrail != null) position.trailing_percent = activeTrail;
  const exitContext = exitTradeContext(position);
  if (position.exit_reason === 'TRAILING_TP' && exitContext.trailingPercent == null && activeTrail != null) {
    exitContext.trailingPercent = activeTrail;
  }
  const slText = strat?.sl_confirmation_enabled
    ? `soft ${fmtPct(strat.sl_soft_percent ?? position.sl_percent)} / hard ${fmtPct(strat.sl_hard_percent ?? position.sl_percent)}`
    : fmtPct(position.sl_percent);
  const slConfirm = strat?.sl_confirmation_enabled
    ? `SL confirm: ${strat.sl_confirm_min_bad_signals ?? 2} bad signals · RSI&lt;=${strat.sl_confirm_rsi_below ?? 38} · BB&lt;=${strat.sl_confirm_bb_below ?? 25} · B/S&lt;=${strat.sl_confirm_buy_pressure_below ?? 0.8}${strat.sl_confirm_supertrend_bearish === false ? '' : ' · ST bearish'}`
    : null;
  const slConfirmExit = exitContext.slConfirmation?.badSignals?.length
    ? `SL signals: ${escapeHtml(exitContext.slConfirmation.badSignals.join(' / '))}`
    : null;
  const stagnationConfirm = strat?.early_exit_enabled && strat?.early_exit_confirmation_enabled
    ? `Stag confirm: ${strat.sl_confirm_min_bad_signals ?? 2} bad signals · same as SL confirm`
    : null;
  const stagnationConfirmExit = exitContext.earlyStagnationConfirmation?.badSignals?.length
    ? `Stag signals: ${escapeHtml(exitContext.earlyStagnationConfirmation.badSignals.join(' / '))}`
    : null;
  return [
    `📍 <b>${escapeHtml(position.symbol || short(position.mint))}</b> #${position.id}`,
    `Token: <a href="${gmgnLink(position.mint)}">${short(position.mint)}</a>`,
    `Status: <b>${escapeHtml(position.status)}</b> · Mode: <b>${escapeHtml(position.execution_mode || 'dry_run')}</b> · Strategy: <b>${escapeHtml(position.strategy_id || 'sniper')}</b>`,
    position.entry_signature ? `Entry TX: <a href="${txLink(position.entry_signature)}">${short(position.entry_signature)}</a>` : null,
    `Entry mcap: ${fmtUsd(position.entry_mcap)} · ${currentMcapLabel}: ${fmtUsd(currentMcap)} · High: ${fmtUsd(position.high_water_mcap)}`,
    `Size: ${fmtSol(position.size_sol)} SOL · Current PnL: ${fmtPct(pnl)}`,
    `Peak PnL: ${fmtPct(peakPnl)}`,
    positionHoldLine(position),
    strat?.trailing_tiers_enabled ? `Trail tiers: ${escapeHtml(trailingTierText(strat))}` : null,
    `TP: ${fmtPct(position.tp_percent)} · SL: ${slText} · Trail: ${position.trailing_enabled ? `${fmtPct(position.trailing_percent)}` : 'off'}`,
    slConfirm,
    slConfirmExit,
    stagnationConfirm,
    stagnationConfirmExit,
    position.exit_reason ? `Exit: ${escapeHtml(formatExitReason(position.exit_reason, exitContext))} at ${fmtUsd(position.exit_mcap)} (${fmtPct(position.pnl_percent)})` : null,
    position.exit_signature ? `Exit TX: <a href="${txLink(position.exit_signature)}">${short(position.exit_signature)}</a>` : null,
  ].filter(Boolean).join('\n');
}

export function compactDecisionCandidate(row) {
  if (!row) return null;
  const c = row.candidate;
  return {
    candidateId: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    jupiterAsset: c.jupiterAsset ? {
      liquidity: c.jupiterAsset.liquidity,
      mcap: c.jupiterAsset.mcap,
      fdv: c.jupiterAsset.fdv,
      usdPrice: c.jupiterAsset.usdPrice,
      fees: c.jupiterAsset.fees,
      holderCount: c.jupiterAsset.holderCount,
      audit: c.jupiterAsset.audit,
      stats1h: c.jupiterAsset.stats1h,
      stats24h: c.jupiterAsset.stats24h,
    } : null,
    holders: {
      count: c.holders?.count,
      top20Percent: c.holders?.top20Percent,
      maxHolderPercent: c.holders?.maxHolderPercent,
      top20: c.holders?.top20,
    },
    chart: c.chart,
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
    createdAtMs: c.createdAtMs,
  };
}
