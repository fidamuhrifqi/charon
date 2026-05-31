function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function normalizeCandles(candles = []) {
  return candles.map(candle => ({
    time: candle.time,
    open: finiteNumber(candle.open),
    high: finiteNumber(candle.high),
    low: finiteNumber(candle.low),
    close: finiteNumber(candle.close),
    volume: finiteNumber(candle.volume) || 0,
  })).filter(candle => (
    candle.open != null &&
    candle.high != null &&
    candle.low != null &&
    candle.close != null &&
    candle.high >= candle.low
  )).sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
}

export function calculateRsi(candles, period = 14) {
  const rows = normalizeCandles(candles);
  const closes = rows.map(candle => candle.close);
  const length = Math.max(2, Math.floor(Number(period) || 14));
  if (closes.length <= length) return null;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss += Math.abs(change);
  }
  let avgGain = gain / length;
  let avgLoss = loss / length;

  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const currentGain = change > 0 ? change : 0;
    const currentLoss = change < 0 ? Math.abs(change) : 0;
    avgGain = ((avgGain * (length - 1)) + currentGain) / length;
    avgLoss = ((avgLoss * (length - 1)) + currentLoss) / length;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return round(100 - (100 / (1 + rs)));
}

export function calculateBollinger(candles, period = 20, stddev = 2) {
  const rows = normalizeCandles(candles);
  const closes = rows.map(candle => candle.close);
  const length = Math.max(2, Math.floor(Number(period) || 20));
  const deviationMultiplier = Math.max(0.1, Number(stddev) || 2);
  if (closes.length < length) return null;

  const window = closes.slice(-length);
  const middle = window.reduce((sum, value) => sum + value, 0) / window.length;
  const variance = window.reduce((sum, value) => sum + ((value - middle) ** 2), 0) / window.length;
  const deviation = Math.sqrt(variance);
  const upper = middle + (deviation * deviationMultiplier);
  const lower = middle - (deviation * deviationMultiplier);
  const close = closes[closes.length - 1];
  const width = upper - lower;
  const bandPosition = width > 0 ? ((close - lower) / width) * 100 : null;

  return {
    period: length,
    stddev: deviationMultiplier,
    upper: round(upper, 10),
    middle: round(middle, 10),
    lower: round(lower, 10),
    bandPosition: round(bandPosition),
    bandwidthPercent: middle > 0 ? round((width / middle) * 100) : null,
  };
}

function trueRange(candle, previous) {
  if (!previous) return candle.high - candle.low;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previous.close),
    Math.abs(candle.low - previous.close),
  );
}

export function calculateSupertrend(candles, period = 10, multiplier = 3) {
  const rows = normalizeCandles(candles);
  const length = Math.max(2, Math.floor(Number(period) || 10));
  const factor = Math.max(0.1, Number(multiplier) || 3);
  if (rows.length <= length + 1) return null;

  const atr = rows.map((candle, index) => {
    if (index < length) return null;
    let sum = 0;
    for (let i = index - length + 1; i <= index; i++) {
      sum += trueRange(rows[i], rows[i - 1]);
    }
    return sum / length;
  });

  let finalUpper = null;
  let finalLower = null;
  let supertrend = null;
  let trend = null;
  let previousTrend = null;
  let lastFlipIndex = null;

  for (let i = length; i < rows.length; i++) {
    const candle = rows[i];
    const previous = rows[i - 1];
    const currentAtr = atr[i];
    if (!Number.isFinite(currentAtr)) continue;
    const hl2 = (candle.high + candle.low) / 2;
    const basicUpper = hl2 + (factor * currentAtr);
    const basicLower = hl2 - (factor * currentAtr);

    if (finalUpper == null || basicUpper < finalUpper || previous.close > finalUpper) finalUpper = basicUpper;
    if (finalLower == null || basicLower > finalLower || previous.close < finalLower) finalLower = basicLower;

    if (supertrend == null) {
      supertrend = candle.close >= hl2 ? finalLower : finalUpper;
    } else if (supertrend === finalUpper) {
      supertrend = candle.close <= finalUpper ? finalUpper : finalLower;
    } else {
      supertrend = candle.close >= finalLower ? finalLower : finalUpper;
    }

    trend = candle.close >= supertrend ? 'bullish' : 'bearish';
    if (previousTrend && trend !== previousTrend) lastFlipIndex = i;
    previousTrend = trend;
  }

  const latest = rows[rows.length - 1];
  const candlesAgo = lastFlipIndex == null ? null : rows.length - 1 - lastFlipIndex;
  return {
    period: length,
    multiplier: factor,
    trend,
    value: round(supertrend, 10),
    distancePercent: supertrend > 0 ? round((latest.close / supertrend - 1) * 100) : null,
    flippedCandlesAgo: candlesAgo,
  };
}

export function analyzeChartIndicators(candles = [], config = {}) {
  const rows = normalizeCandles(candles);
  if (!rows.length) return { available: false };
  const rsiPeriod = Math.max(2, Math.floor(Number(config.rsi_period) || 14));
  const bbPeriod = Math.max(2, Math.floor(Number(config.bb_period) || 20));
  const stPeriod = Math.max(2, Math.floor(Number(config.supertrend_atr_period) || 10));
  const rsi = calculateRsi(rows, rsiPeriod);
  const bollinger = calculateBollinger(rows, bbPeriod, config.bb_stddev ?? 2);
  const supertrend = calculateSupertrend(rows, stPeriod, config.supertrend_multiplier ?? 3);
  const bbrsi = rsi != null && bollinger ? {
    rsi,
    bandPosition: bollinger.bandPosition,
    overbought: rsi >= Number(config.bbrsi_overbought_rsi ?? config.rsi_max ?? 78)
      && Number(bollinger.bandPosition) >= Number(config.bbrsi_max_band_pos ?? 105),
    oversold: rsi <= Number(config.rsi_min ?? 45)
      && Number(bollinger.bandPosition) <= 0,
  } : null;
  const requiredCandles = {
    rsi: rsiPeriod + 1,
    bollinger: bbPeriod,
    supertrend: stPeriod + 2,
    bbrsi: Math.max(rsiPeriod + 1, bbPeriod),
  };
  const ready = {
    rsi: rsi != null,
    bollinger: Boolean(bollinger),
    supertrend: Boolean(supertrend?.trend),
    bbrsi: Boolean(bbrsi),
  };
  const insufficient = Object.entries(requiredCandles)
    .filter(([key, required]) => !ready[key] && rows.length < required)
    .map(([key, required]) => ({ indicator: key, requiredCandles: required }));

  return {
    available: true,
    candleCount: rows.length,
    timeframe: config.indicator_timeframe || config.indicator_interval || '5m',
    ready,
    warmup: {
      active: insufficient.length > 0,
      requiredCandles,
      insufficient,
    },
    rsi: rsi == null ? null : { period: rsiPeriod, value: rsi },
    bollinger,
    supertrend,
    bbrsi,
  };
}
