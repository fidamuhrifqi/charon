import { db } from './connection.js';

export function setting(key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function boolSetting(key, fallback = false) {
  const value = setting(key, fallback ? 'true' : 'false');
  return value === 'true' || value === '1' || value === 'yes';
}

export function numSetting(key, fallback = 0) {
  const value = Number(setting(key, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

const strategyCache = { id: null, config: null, at: 0 };

export function activeStrategy() {
  if (strategyCache.config && Date.now() - strategyCache.at < 5000) return strategyCache.config;
  const row = db.prepare('SELECT * FROM strategies WHERE enabled = 1 LIMIT 1').get();
  if (!row) {
    const fallback = strategyById('sniper');
    if (fallback) return fallback;
    return defaultStrategy();
  }
  const config = { id: row.id, name: row.name, ...JSON.parse(row.config_json) };
  strategyCache.id = row.id;
  strategyCache.config = config;
  strategyCache.at = Date.now();
  return config;
}

export function strategyById(id) {
  const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
  if (!row) return null;
  return { id: row.id, name: row.name, ...JSON.parse(row.config_json) };
}

export function allStrategies() {
  return db.prepare('SELECT * FROM strategies ORDER BY id').all().map(row => ({
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    ...JSON.parse(row.config_json),
  }));
}

export function setActiveStrategy(id) {
  db.prepare('UPDATE strategies SET enabled = 0').run();
  db.prepare('UPDATE strategies SET enabled = 1 WHERE id = ?').run(id);
  strategyCache.config = null;
  strategyCache.at = 0;
}

export function updateStrategyConfig(id, config) {
  db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
  if (strategyCache.id === id) {
    strategyCache.config = null;
    strategyCache.at = 0;
  }
}

export function strategySetting(key, fallback) {
  const strat = activeStrategy();
  if (strat[key] !== undefined && strat[key] !== null) return strat[key];
  return numSetting(key, fallback);
}

function defaultStrategy() {
  return {
    id: 'sniper', name: 'Sniper',
    entry_mode: 'immediate', min_source_count: 3, require_fee_claim: false,
    source_gate_enabled: true, source_require_fee: false, source_require_graduated: true, source_require_trending: true,
    token_age_max_ms: 3600000, min_mcap_usd: 7000, max_mcap_usd: 200000,
    min_fee_claim_sol: 0.5, min_gmgn_total_fee_sol: 10, min_holders: 0,
    max_top20_holder_percent: 100, min_saved_wallet_holders: 0, max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0, trending_min_volume_usd: 0, trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3, trending_max_bundler_rate: 0.5,
    position_size_sol: 0.1, max_open_positions: 3,
    tp_percent: 50, sl_percent: -25, trailing_enabled: true, trailing_percent: 5,
    trailing_tiers_enabled: true, trailing_floor_at_percent: 10, trailing_floor_percent: 5,
    trailing_tier_1_at_percent: 20, trailing_tier_1_percent: 10,
    trailing_tier_2_at_percent: 30, trailing_tier_2_percent: 15,
    trailing_tier_3_at_percent: 60, trailing_tier_3_percent: 20,
    trailing_tier_4_at_percent: 100, trailing_tier_4_percent: 30,
    partial_tp: false, partial_tp_at_percent: 0, partial_tp_sell_percent: 0,
    max_hold_ms: 900000,
    early_exit_enabled: true, early_exit_check_after_ms: 90000,
    early_exit_min_peak_pnl_percent: 5, early_exit_max_current_pnl_percent: 0,
    early_loss_guard_enabled: true, early_loss_check_after_ms: 60000,
    early_loss_window_ms: 180000, early_loss_exit_pnl_percent: -7,
    use_llm: true, llm_min_confidence: 50,
    profit_cooldown_enabled: true, profit_cooldown_scope: 'mint',
    profit_cooldown_min_profit_percent: 15, profit_cooldown_max_wins: 1,
    profit_cooldown_min_loss_percent: 17, profit_cooldown_max_losses: 2,
    profit_cooldown_minutes: 60,
    chart_indicators_enabled: true, chart_indicators_hard_filter: false, indicator_timeframe: '1m', supertrend_required: true,
    supertrend_atr_period: 10, supertrend_multiplier: 3,
    rsi_guard_enabled: true, rsi_period: 14, rsi_min: 45, rsi_max: 78,
    bbrsi_guard_enabled: true, bbrsi_overbought_rsi: 78, bbrsi_max_band_pos: 105,
    bb_buy_pressure_guard_enabled: true, bb_buy_pressure_min_band_pos: 80, bb_buy_pressure_min_ratio: 1.5,
    bb_period: 20, bb_stddev: 2,
  };
}
