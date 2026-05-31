function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function peakPnlPercent(position) {
  const entry = finiteNumber(position?.entry_mcap);
  const high = finiteNumber(position?.high_water_mcap);
  if (!entry || entry <= 0 || !high || high <= 0) return null;
  return (high / entry - 1) * 100;
}

export function trailingTiers(strat = {}) {
  return [1, 2, 3, 4].map(index => ({
    atPercent: finiteNumber(strat[`trailing_tier_${index}_at_percent`]),
    trailPercent: finiteNumber(strat[`trailing_tier_${index}_percent`]),
  })).filter(tier => (
    Number.isFinite(tier.atPercent) &&
    Number.isFinite(tier.trailPercent) &&
    tier.atPercent > 0 &&
    tier.trailPercent > 0
  )).sort((a, b) => a.atPercent - b.atPercent);
}

export function trailingFloor(strat = {}) {
  if (strat.trailing_floor_enabled === false) return null;
  const atPercent = finiteNumber(strat.trailing_floor_at_percent);
  const floorPercent = finiteNumber(strat.trailing_floor_percent);
  if (!Number.isFinite(atPercent) || !Number.isFinite(floorPercent)) return null;
  if (atPercent <= 0 || floorPercent <= 0) return null;
  return { atPercent, floorPercent };
}

export function effectiveTrailingPercent(position, strat = {}, peakPercent = null) {
  const base = Math.abs(finiteNumber(position?.trailing_percent, finiteNumber(strat.trailing_percent, 0)) || 0);
  if (!strat.trailing_tiers_enabled) return base;

  const peak = finiteNumber(peakPercent, peakPnlPercent(position));
  if (!Number.isFinite(peak)) return base;

  let effective = base;
  for (const tier of trailingTiers(strat)) {
    if (peak >= tier.atPercent) effective = Math.abs(tier.trailPercent);
  }
  return effective;
}

export function trailingTierText(strat = {}) {
  if (!strat.trailing_tiers_enabled) return 'off';
  const tiers = trailingTiers(strat);
  const floor = trailingFloor(strat);
  const parts = [
    floor ? `${floor.atPercent}%->floor${floor.floorPercent}%` : null,
    ...tiers.map(tier => `${tier.atPercent}%=>${tier.trailPercent}%`),
  ].filter(Boolean);
  if (!parts.length) return 'on, no tiers';
  return parts.join(' / ');
}
