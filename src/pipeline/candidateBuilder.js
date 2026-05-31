import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { gmgnLink } from '../format.js';
import { profitCooldownFailureText, profitCooldownStatus } from './profitCooldown.js';

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

function boolConfig(strat, key, fallback = false) {
  return strat[key] === undefined || strat[key] === null ? fallback : Boolean(strat[key]);
}

function numConfig(strat, key, fallback = 0) {
  const number = Number(strat[key]);
  return Number.isFinite(number) ? number : fallback;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function buySellPressure(candidate) {
  const gmgnPrice = candidate.gmgn?.price || {};
  const trending = candidate.trending || {};
  const sources = [
    {
      source: 'gmgn 5m',
      buys: firstFiniteNumber(gmgnPrice.buys_5m),
      sells: firstFiniteNumber(gmgnPrice.sells_5m),
    },
    {
      source: 'trending',
      buys: firstFiniteNumber(trending.buys),
      sells: firstFiniteNumber(trending.sells),
    },
  ];

  for (const item of sources) {
    if (!Number.isFinite(item.buys) || !Number.isFinite(item.sells)) continue;
    if (item.buys + item.sells <= 0) continue;
    return {
      ...item,
      ratio: item.buys / Math.max(1, item.sells),
    };
  }

  return null;
}

function applyBbBuyPressureFilter(candidate, strat, indicators, failures) {
  if (!boolConfig(strat, 'bb_buy_pressure_guard_enabled', false)) return;
  const bandPosition = firstFiniteNumber(indicators.bollinger?.bandPosition, indicators.bbrsi?.bandPosition);
  if (!Number.isFinite(bandPosition)) return;

  const minBandPosition = numConfig(strat, 'bb_buy_pressure_min_band_pos', 80);
  if (minBandPosition <= 0 || bandPosition < minBandPosition) return;

  const pressure = buySellPressure(candidate);
  if (!pressure) return;

  const minRatio = numConfig(strat, 'bb_buy_pressure_min_ratio', 1.5);
  if (minRatio > 0 && pressure.ratio <= minRatio) {
    failures.push(`BB buy pressure: BB ${bandPosition.toFixed(1)}% >= ${minBandPosition}%, buy/sell ${pressure.ratio.toFixed(2)} <= ${minRatio} (${pressure.source})`);
  }
}

function applyBuyPressureFilter(candidate, strat, failures) {
  if (!boolConfig(strat, 'buy_pressure_guard_enabled', false)) return;
  const minRatio = numConfig(strat, 'buy_pressure_min_ratio', 0);
  if (minRatio <= 0) return;

  const pressure = buySellPressure(candidate);
  if (!pressure) return;

  if (pressure.ratio <= minRatio) {
    failures.push(`buy pressure: buy/sell ${pressure.ratio.toFixed(2)} <= ${minRatio} (${pressure.source})`);
  }
}

function applyIndicatorFilters(candidate, strat, failures) {
  if (!boolConfig(strat, 'chart_indicators_enabled', false)) return;
  const indicators = candidate.chart?.indicators;
  if (!indicators?.available) return;

  if (boolConfig(strat, 'chart_indicators_hard_filter', false)) {
    const supertrend = indicators.supertrend;
    if (boolConfig(strat, 'supertrend_required', false) && supertrend?.trend === 'bearish') {
      failures.push('supertrend: bearish');
    }

    const rsi = Number(indicators.rsi?.value);
    if (boolConfig(strat, 'rsi_guard_enabled', true) && Number.isFinite(rsi)) {
      const min = numConfig(strat, 'rsi_min', 45);
      const max = numConfig(strat, 'rsi_max', 78);
      if (min > 0 && rsi < min) failures.push(`RSI: ${rsi} < ${min}`);
      if (max > 0 && rsi > max) failures.push(`RSI: ${rsi} > ${max}`);
    }

    const bbrsi = indicators.bbrsi;
    if (boolConfig(strat, 'bbrsi_guard_enabled', true) && bbrsi) {
      const overboughtRsi = numConfig(strat, 'bbrsi_overbought_rsi', numConfig(strat, 'rsi_max', 78));
      const maxBandPos = numConfig(strat, 'bbrsi_max_band_pos', 105);
      if (Number(bbrsi.rsi) >= overboughtRsi && Number(bbrsi.bandPosition) >= maxBandPos) {
        failures.push(`BBRSI: RSI ${bbrsi.rsi} and band ${bbrsi.bandPosition}% >= ${overboughtRsi}/${maxBandPos}%`);
      }
    }
  }

  applyBbBuyPressureFilter(candidate, strat, indicators, failures);
}

function sourceFlagsFromCandidate(candidate) {
  return {
    hasFee: Boolean(candidate.feeClaim || candidate.signals?.hasFeeClaim),
    hasGraduated: Boolean(candidate.graduation || candidate.signals?.hasGraduated),
    hasTrending: Boolean(candidate.trending || candidate.signals?.hasTrending),
    sourceCount: Number(candidate.signals?.sourceCount || 0),
  };
}

export function sourceGateStatus(sources, strat = activeStrategy()) {
  const sourceCount = Number(sources.sourceCount || 0);
  const enabled = Boolean(strat.source_gate_enabled);
  const required = {
    fee: Boolean(strat.source_require_fee),
    graduated: Boolean(strat.source_require_graduated),
    trending: Boolean(strat.source_require_trending),
  };
  const primaryPass = !enabled || (
    (!required.fee || sources.hasFee) &&
    (!required.graduated || sources.hasGraduated) &&
    (!required.trending || sources.hasTrending)
  );
  const fallbackMin = Math.max(0, Math.floor(Number(strat.min_source_count || 0)));
  const fallbackPass = enabled && fallbackMin > 0 && sourceCount >= fallbackMin;
  return {
    enabled,
    required,
    primaryPass,
    fallbackPass,
    fallbackMin,
    sourceCount,
    passed: primaryPass || fallbackPass,
    sources: {
      fee: Boolean(sources.hasFee),
      graduated: Boolean(sources.hasGraduated),
      trending: Boolean(sources.hasTrending),
    },
  };
}

export function sourceGateFailureText(status) {
  const required = Object.entries(status.required)
    .filter(([, value]) => value)
    .map(([key]) => key)
    .join('+') || 'none';
  const present = Object.entries(status.sources)
    .filter(([, value]) => value)
    .map(([key]) => key)
    .join('+') || 'none';
  const fallback = status.fallbackMin > 0
    ? ` or min sources ${status.fallbackMin} fallback (got ${status.sourceCount})`
    : '';
  return `source gate: requires ${required}${fallback}; got ${present}`;
}

export function filterCandidate(candidate, strat = activeStrategy()) {
  const failures = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);
  const sourceGate = sourceGateStatus(sourceFlagsFromCandidate(candidate), strat);
  if (sourceGate.enabled && !sourceGate.passed) failures.push(sourceGateFailureText(sourceGate));

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap checks
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count
  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // ATH distance (dip buy strategy)
  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  applyIndicatorFilters(candidate, strat, failures);
  applyBuyPressureFilter(candidate, strat, failures);

  const cooldown = profitCooldownStatus(candidate, strat);
  if (cooldown.active) failures.push(profitCooldownFailureText(cooldown));

  return { passed: failures.length === 0, failures, strategy: strat.id };
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route, sourceCount = null }) {
  const strat = activeStrategy();
  const gmgn = await fetchGmgnTokenInfo(mint);
  const jupiterAsset = await fetchJupiterAsset(mint);
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint, strat);
  const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  const twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');
  const normalizedSourceCount = Number.isFinite(Number(sourceCount))
    ? Number(sourceCount)
    : [fee, graduatedCoin, trendingToken].filter(Boolean).length;

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      sourceCount: normalizedSourceCount,
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    createdAtMs: now(),
  };
  candidate.filters = filterCandidate(candidate, strat);
  return candidate;
}
