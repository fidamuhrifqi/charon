import { db } from '../db/connection.js';
import { now } from '../utils.js';

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function profitCooldownFromRows(rows, config = {}, nowMs = now()) {
  const minProfit = finiteNumber(config.profit_cooldown_min_profit_percent, 5);
  const triggerWins = Math.max(0, Math.floor(finiteNumber(config.profit_cooldown_max_wins, 2)));
  const minLoss = Math.abs(finiteNumber(config.profit_cooldown_min_loss_percent, 0));
  const triggerLosses = Math.max(0, Math.floor(finiteNumber(config.profit_cooldown_max_losses, 0)));
  const cooldownMs = Math.max(0, finiteNumber(config.profit_cooldown_minutes, 30) * 60 * 1000);
  if (!cooldownMs || (!triggerWins && !triggerLosses)) {
    return {
      active: false,
      wins: 0,
      losses: 0,
      triggerWins,
      triggerLosses,
      minProfit,
      minLoss,
      cooldownMs,
      untilMs: null,
      reasons: [],
    };
  }

  const cutoff = nowMs - cooldownMs;
  const closed = rows.map(row => ({
    id: row.id,
    mint: row.mint,
    symbol: row.symbol,
    pnlPercent: finiteNumber(row.pnl_percent, 0),
    closedAtMs: finiteNumber(row.closed_at_ms, 0),
  })).filter(row => row.closedAtMs >= cutoff);

  const wins = closed
    .filter(row => triggerWins > 0 && row.pnlPercent >= minProfit)
    .sort((a, b) => a.closedAtMs - b.closedAtMs);
  const losses = closed
    .filter(row => triggerLosses > 0 && minLoss > 0 && row.pnlPercent <= -minLoss)
    .sort((a, b) => a.closedAtMs - b.closedAtMs);

  const reasons = [];
  if (triggerWins > 0 && wins.length >= triggerWins) {
    reasons.push({
      type: 'win',
      count: wins.length,
      trigger: triggerWins,
      threshold: minProfit,
      untilMs: wins[wins.length - triggerWins].closedAtMs + cooldownMs,
    });
  }
  if (triggerLosses > 0 && minLoss > 0 && losses.length >= triggerLosses) {
    reasons.push({
      type: 'loss',
      count: losses.length,
      trigger: triggerLosses,
      threshold: minLoss,
      untilMs: losses[losses.length - triggerLosses].closedAtMs + cooldownMs,
    });
  }

  const active = reasons.length > 0;
  const untilMs = active ? Math.max(...reasons.map(reason => reason.untilMs)) : null;
  return {
    active,
    wins: wins.length,
    losses: losses.length,
    triggerWins,
    triggerLosses,
    minProfit,
    minLoss,
    cooldownMs,
    untilMs,
    reasons,
    recent: wins.slice(-5),
    recentLosses: losses.slice(-5),
  };
}

export function profitCooldownStatus(candidate = {}, strat = {}, nowMs = now()) {
  if (!strat.profit_cooldown_enabled) return { active: false };
  const mint = candidate.token?.mint;
  if (!mint) return { active: false, mint: '' };

  const cooldownMs = Math.max(0, finiteNumber(strat.profit_cooldown_minutes, 30) * 60 * 1000);
  const cutoff = nowMs - cooldownMs;
  const rows = db.prepare(`
    SELECT id, mint, symbol, closed_at_ms, pnl_percent
    FROM dry_run_positions
    WHERE status = 'closed'
      AND mint = ?
      AND closed_at_ms >= ?
    ORDER BY closed_at_ms DESC
    LIMIT 500
  `).all(mint, cutoff);

  return {
    mint,
    scope: 'mint',
    ...profitCooldownFromRows(rows, strat, nowMs),
  };
}

export function profitCooldownFailureText(status) {
  const minutesLeft = status.untilMs ? Math.max(1, Math.ceil((status.untilMs - now()) / 60000)) : null;
  const reasonText = (status.reasons || []).map(reason => (
    reason.type === 'loss'
      ? `${reason.count} losses <= -${reason.threshold}% trigger ${reason.trigger}`
      : `${reason.count} wins >= ${reason.threshold}% trigger ${reason.trigger}`
  )).join('; ');
  return [
    `profit cooldown: mint ${reasonText || 'triggered'}`,
    minutesLeft ? `${minutesLeft}m left` : null,
  ].filter(Boolean).join(' · ');
}
