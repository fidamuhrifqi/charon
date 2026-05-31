import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { liveWalletPubkey } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositionByMint, openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';
import { effectiveTrailingPercent, trailingFloor, trailingTiers } from './trailing.js';

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const strat = strategyById(candidate.filters?.strategy || candidate.signals?.strategy);
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint, strat || undefined);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed, strat || undefined);
  const executionFailures = [];
  const originalMarketCapUsd = firstPositiveNumber(
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const freshDropGuardEnabled = Boolean(strat?.fresh_mcap_dump_guard_enabled);
  const maxFreshDropPercent = Math.abs(Number(strat?.fresh_mcap_max_drop_percent || 0));
  if (
    freshDropGuardEnabled &&
    maxFreshDropPercent > 0 &&
    Number.isFinite(Number(originalMarketCapUsd)) &&
    Number(originalMarketCapUsd) > 0 &&
    Number.isFinite(Number(marketCapUsd)) &&
    Number(marketCapUsd) > 0
  ) {
    const freshDropPercent = (Number(marketCapUsd) / Number(originalMarketCapUsd) - 1) * 100;
    if (freshDropPercent <= -maxFreshDropPercent) {
      executionFailures.push(`fresh mcap drop: ${freshDropPercent.toFixed(1)}% <= -${maxFreshDropPercent}%`);
    }
  }
  const existingOpenPosition = openPositionByMint(mint);
  if (existingOpenPosition) {
    executionFailures.push(`open position already exists for this token (#${existingOpenPosition.id})`);
  }
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();
const POSITION_ASSET_TTL_MS = 10_000;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function negativePercent(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? -number : number;
}

function gmgnBuyPressure(gmgn) {
  const priceStats = gmgn?.price || {};
  const buys = Number(priceStats.buys_5m);
  const sells = Number(priceStats.sells_5m);
  if (!Number.isFinite(buys) || !Number.isFinite(sells) || buys + sells <= 0) return null;
  return {
    buys,
    sells,
    ratio: buys / Math.max(1, sells),
    source: 'gmgn 5m',
  };
}

async function badSignalConfirmationStatus(position, strat, pnlPercent, highWaterPnlPercent, reason = 'exit') {
  const minBadSignals = Math.max(1, Math.floor(finiteNumber(strat?.sl_confirm_min_bad_signals, 2)));
  const rsiBelow = finiteNumber(strat?.sl_confirm_rsi_below, 38);
  const bbBelow = finiteNumber(strat?.sl_confirm_bb_below, 25);
  const buyPressureBelow = finiteNumber(strat?.sl_confirm_buy_pressure_below, 0.8);
  const useSupertrend = Boolean(strat?.sl_confirm_supertrend_bearish ?? true);
  const badSignals = [];
  const unavailable = [];
  let chart = null;
  let gmgn = null;

  try {
    chart = await fetchJupiterChartContext(position.mint, strat || {});
  } catch (err) {
    unavailable.push(`chart: ${err.message}`);
  }

  try {
    gmgn = await fetchGmgnTokenInfo(position.mint, false);
  } catch (err) {
    unavailable.push(`gmgn: ${err.message}`);
  }

  const indicators = chart?.indicators || {};
  const rsi = Number(indicators.rsi?.value);
  const bb = Number(indicators.bollinger?.bandPosition ?? indicators.bbrsi?.bandPosition);
  const supertrendRaw = String(indicators.supertrend?.trend || indicators.supertrend?.direction || '').toLowerCase();
  const pressure = gmgnBuyPressure(gmgn);

  if (Number.isFinite(rsi)) {
    if (rsi <= rsiBelow) badSignals.push(`RSI ${rsi.toFixed(1)} <= ${rsiBelow}`);
  } else {
    unavailable.push('RSI');
  }

  if (Number.isFinite(bb)) {
    if (bb <= bbBelow) badSignals.push(`BB ${bb.toFixed(1)} <= ${bbBelow}`);
  } else {
    unavailable.push('BB');
  }

  if (pressure) {
    if (pressure.ratio <= buyPressureBelow) {
      badSignals.push(`buy/sell ${pressure.ratio.toFixed(2)} <= ${buyPressureBelow}`);
    }
  } else {
    unavailable.push('buy pressure');
  }

  if (useSupertrend) {
    if (supertrendRaw) {
      if (supertrendRaw === 'bearish') badSignals.push('supertrend bearish');
    } else {
      unavailable.push('supertrend');
    }
  }

  return {
    checked: true,
    reason,
    confirmed: badSignals.length >= minBadSignals,
    badSignals,
    unavailable,
    minBadSignals,
    pnlPercent,
    highWaterPnlPercent,
    values: {
      rsi: Number.isFinite(rsi) ? rsi : null,
      bb: Number.isFinite(bb) ? bb : null,
      supertrend: supertrendRaw || null,
      buyPressure: pressure?.ratio ?? null,
    },
    thresholds: {
      rsiBelow,
      bbBelow,
      buyPressureBelow,
      useSupertrend,
    },
  };
}

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  const asset = await fetchJupiterAsset(position.mint, { ttlMs: POSITION_ASSET_TTL_MS });
  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  let pnlSol = Number(position.size_sol) * pnlPercent / 100;
  if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlPercentageNative))) {
    pnlPercent = Number(jupiterPnl.totalPnlPercentageNative);
    pnlSol = Number.isFinite(Number(jupiterPnl.totalPnlNative)) ? Number(jupiterPnl.totalPnlNative) : pnlSol;
  }
  const strat = strategyById(position.strategy_id);
  const heldMs = Math.max(0, now() - Number(position.opened_at_ms || 0));
  const highWaterPnlPercent = Number(position.entry_mcap) > 0 ? (highWaterMcap / Number(position.entry_mcap) - 1) * 100 : null;
  const tiers = strat?.trailing_tiers_enabled ? trailingTiers(strat) : [];
  const floor = strat?.trailing_tiers_enabled ? trailingFloor(strat) : null;
  const tierArmPercent = tiers[0]?.atPercent;
  const trailingArmPercentCandidates = [floor?.atPercent, tierArmPercent, Number(position.tp_percent)]
    .map(Number)
    .filter(Number.isFinite);
  const trailingArmPercent = trailingArmPercentCandidates.length ? Math.min(...trailingArmPercentCandidates) : null;
  const tpHit = pnlPercent >= Number(position.tp_percent);
  const slConfirmationEnabled = Boolean(strat?.sl_confirmation_enabled);
  const softSlPercent = negativePercent(strat?.sl_soft_percent, Number(position.sl_percent));
  const hardSlPercent = negativePercent(strat?.sl_hard_percent, Number(position.sl_percent));
  const hardSlHit = slConfirmationEnabled && Number.isFinite(Number(pnlPercent)) && pnlPercent <= hardSlPercent;
  const softSlZone = slConfirmationEnabled && Number.isFinite(Number(pnlPercent)) && pnlPercent <= softSlPercent;
  let slConfirmation = null;
  if (softSlZone && !hardSlHit) {
    slConfirmation = await badSignalConfirmationStatus(position, strat || {}, pnlPercent, highWaterPnlPercent, 'soft_sl');
  }
  const softSlHit = Boolean(slConfirmationEnabled && softSlZone && slConfirmation?.confirmed);
  const slHit = slConfirmationEnabled
    ? hardSlHit || softSlHit
    : pnlPercent <= Number(position.sl_percent);
  const trailingArmed = position.trailing_armed || (
    position.trailing_enabled &&
    Number.isFinite(trailingArmPercent) &&
    (pnlPercent >= trailingArmPercent || Number(highWaterPnlPercent) >= trailingArmPercent)
  );
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  const mcapTrailDropPercent = highWaterMcap > 0 ? Math.max(0, (1 - Number(mcap) / highWaterMcap) * 100) : 0;
  let exitReason = null;
  let closed = false;

  // Max hold time check
  const activeTrailingPercent = effectiveTrailingPercent(
    { ...position, high_water_mcap: highWaterMcap },
    strat || {},
    highWaterPnlPercent,
  );
  const pnlTrailDrop = Number.isFinite(Number(highWaterPnlPercent)) ? highWaterPnlPercent - pnlPercent : 0;
  const normalTrailingArmed = trailingArmed && (
    !strat?.trailing_tiers_enabled ||
    !Number.isFinite(Number(tierArmPercent)) ||
    Number(highWaterPnlPercent) >= Number(tierArmPercent)
  );
  const floorArmed = position.trailing_enabled &&
    trailingArmed &&
    floor &&
    Number(highWaterPnlPercent) >= floor.atPercent &&
    (!Number.isFinite(Number(tierArmPercent)) || Number(highWaterPnlPercent) < Number(tierArmPercent));
  const trailingCanExit = Number.isFinite(Number(pnlPercent)) && pnlPercent > 0;
  const floorHit = floorArmed && trailingCanExit && pnlPercent <= floor.floorPercent;
  const trailingHit = (
    trailingCanExit &&
    normalTrailingArmed &&
    position.trailing_enabled &&
    mcapTrailDropPercent >= activeTrailingPercent
  ) || floorHit;
  const earlyLossCheckMs = finiteNumber(strat?.early_loss_check_after_ms, 0);
  const earlyLossWindowMs = finiteNumber(strat?.early_loss_window_ms, 0);
  const earlyLossExitPnlRaw = finiteNumber(strat?.early_loss_exit_pnl_percent, 0);
  const earlyLossExitPnl = earlyLossExitPnlRaw > 0 ? -earlyLossExitPnlRaw : earlyLossExitPnlRaw;
  const earlyLossWithinWindow = earlyLossWindowMs <= 0 || heldMs <= earlyLossWindowMs;
  const earlyLossHit = Boolean(
    strat?.early_loss_guard_enabled &&
    earlyLossCheckMs > 0 &&
    heldMs >= earlyLossCheckMs &&
    earlyLossWithinWindow &&
    Number.isFinite(Number(pnlPercent)) &&
    pnlPercent <= earlyLossExitPnl,
  );
  const earlyExitCheckMs = finiteNumber(strat?.early_exit_check_after_ms, 0);
  const earlyExitMinPeak = finiteNumber(strat?.early_exit_min_peak_pnl_percent, 0);
  const earlyExitMaxCurrent = finiteNumber(strat?.early_exit_max_current_pnl_percent, 0);
  const earlyStagnationZone = Boolean(
    strat?.early_exit_enabled &&
    earlyExitCheckMs > 0 &&
    heldMs >= earlyExitCheckMs &&
    Number.isFinite(Number(highWaterPnlPercent)) &&
    Number.isFinite(Number(pnlPercent)) &&
    highWaterPnlPercent < earlyExitMinPeak &&
    pnlPercent <= earlyExitMaxCurrent,
  );
  const earlyStagnationConfirmationEnabled = Boolean(strat?.early_exit_confirmation_enabled);
  let earlyStagnationConfirmation = null;
  if (earlyStagnationZone && earlyStagnationConfirmationEnabled) {
    earlyStagnationConfirmation = slConfirmation
      ? { ...slConfirmation, reason: 'early_stagnation', reusedFrom: slConfirmation.reason }
      : await badSignalConfirmationStatus(position, strat || {}, pnlPercent, highWaterPnlPercent, 'early_stagnation');
  }
  const earlyStagnationHit = earlyStagnationConfirmationEnabled
    ? Boolean(earlyStagnationZone && earlyStagnationConfirmation?.confirmed)
    : earlyStagnationZone;
  const maxHoldHit = strat?.max_hold_ms > 0 && heldMs >= strat.max_hold_ms;

  // Partial TP check
  if (!exitReason && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${strat.partial_tp_sell_percent}% sell)`);
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const sellAmount = Math.floor(Number(position.token_amount_raw) * (strat.partial_tp_sell_percent / 100));
        if (sellAmount > 0) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
          const remaining = Number(position.token_amount_raw) - sellAmount;
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (strat.partial_tp_sell_percent / 100), sellAmount,
            json({ pnlPercent, sell, partialSellPercent: strat.partial_tp_sell_percent, remaining }));
          console.log(`[position] ${position.id} partial TP sold ${sellAmount} tokens, ${remaining} remaining`);
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
      }
    }
  }

  // Standard exit checks
  if (!exitReason) {
    if (slConfirmationEnabled && hardSlHit) exitReason = 'HARD_SL';
    else if (slConfirmationEnabled && softSlHit) exitReason = 'SOFT_SL';
    else if (slHit) exitReason = 'SL';
    else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
    else if (earlyLossHit) exitReason = 'EARLY_WEAKNESS';
    else if (earlyStagnationHit) exitReason = 'EARLY_STAGNATION';
    else if (maxHoldHit) exitReason = 'MAX_HOLD';
  }

  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?,
        pnl_percent = ?, pnl_sol = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0, pnlPercent, pnlSol, position.id);

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      finalPnlSol = receivedSol - Number(position.size_sol);
      finalPnlPercent = (receivedSol / Number(position.size_sol) - 1) * 100;
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell, trailDrop, pnlTrailDrop, mcapTrailDropPercent, trailingBasis: 'mcap_drop_from_high', trailingSkippedBelowEntry: !trailingCanExit, trailingPercent: activeTrailingPercent, highWaterPnlPercent, floorHit, floorPercent: floorHit ? floor.floorPercent : null, floorAtPercent: floorHit ? floor.atPercent : null, heldMs, earlyLossHit, earlyStagnationZone, earlyStagnationHit, earlyStagnationConfirmationEnabled, earlyStagnationConfirmation, earlyLossCheckMs, earlyLossWindowMs, earlyLossWithinWindow, earlyLossExitPnl, earlyExitCheckMs, earlyExitMinPeak, earlyExitMaxCurrent, slConfirmationEnabled, softSlPercent, hardSlPercent, hardSlHit, softSlZone, softSlHit, slConfirmation }));
    closed = true;
  } else if (exitReason && autoExit) {
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent, pnlSol, trailDrop, pnlTrailDrop, mcapTrailDropPercent, trailingBasis: 'mcap_drop_from_high', trailingSkippedBelowEntry: !trailingCanExit, trailingPercent: activeTrailingPercent, highWaterPnlPercent, floorHit, floorPercent: floorHit ? floor.floorPercent : null, floorAtPercent: floorHit ? floor.atPercent : null, heldMs, earlyLossHit, earlyStagnationZone, earlyStagnationHit, earlyStagnationConfirmationEnabled, earlyStagnationConfirmation, earlyLossCheckMs, earlyLossWindowMs, earlyLossWithinWindow, earlyLossExitPnl, earlyExitCheckMs, earlyExitMinPeak, earlyExitMaxCurrent, slConfirmationEnabled, softSlPercent, hardSlPercent, hardSlHit, softSlZone, softSlHit, slConfirmation }));
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
    effective_trailing_percent: activeTrailingPercent,
    sl_confirmation: slConfirmation,
    early_stagnation_confirmation: earlyStagnationConfirmation,
  };
}

export async function monitorPositions() {
  const positions = openPositions();
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  for (const position of positions) {
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) await sendPositionExit(result);
  }
}
