import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, parseDurationInput, parseNumericInput } from '../utils.js';
import { activeStrategy, setSetting, updateStrategyConfig } from '../db/settings.js';
import {
  filtersText,
  filtersKeyboard,
  numericFilterLabels,
  navKeyboard,
  cooldownKeyboard,
  cooldownText,
  strategyKeyboard,
  strategyMenuText,
  strategyNumericLabels,
} from './menus.js';

export const pendingNumericInputs = new Map();

const durationStrategyKeys = new Set(['max_hold_ms', 'early_exit_check_after_ms', 'early_loss_check_after_ms', 'early_loss_window_ms']);

export async function requestNumericFilterInput(query, key) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  if (!numericFilterLabels[key]) return bot.sendMessage(chatId, 'Unknown numeric filter.');
  pendingNumericInputs.set(String(chatId), {
    type: 'setting',
    key,
    at: now(),
    messageId: query.message?.message_id || null,
  });
  return editMenuMessage(
    query,
    `Send a number for ${numericFilterLabels[key]}.\nExamples: 5, 50000, 100k, 1.5m, off`,
    navKeyboard([[{ text: 'Cancel', callback_data: 'menu:filters' }]]),
  );
}

export async function requestStrategyNumericInput(query, key, returnMenu = 'strategy') {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  if (!strategyNumericLabels[key]) return bot.sendMessage(chatId, 'Unknown strategy setting.');
  const strat = activeStrategy();
  pendingNumericInputs.set(String(chatId), {
    type: 'strategy',
    key,
    strategyId: strat.id,
    returnMenu,
    at: now(),
    messageId: query.message?.message_id || null,
  });
  const examples = durationStrategyKeys.has(key)
    ? 'Examples: 45m, 1h, 1h30m, 2h, off'
    : 'Examples: 5, 50000, 100k, 1.5m, -40, off';
  return editMenuMessage(
    query,
    `Send a value for ${strat.name} ${strategyNumericLabels[key]}.\n${examples}`,
    navKeyboard([[{ text: 'Cancel', callback_data: returnMenu === 'cooldown' ? 'menu:cooldown' : 'menu:strategy' }]]),
  );
}

export async function consumeNumericFilterInput(chatId, text, userMessageId = null) {
  const pending = pendingNumericInputs.get(String(chatId));
  if (!pending) return false;
  if (now() - pending.at > 5 * 60 * 1000) {
    pendingNumericInputs.delete(String(chatId));
    await bot.sendMessage(chatId, 'That input expired. Tap the filter input button again.');
    return true;
  }
  const value = pending.type === 'strategy' && durationStrategyKeys.has(pending.key)
    ? parseDurationInput(text)
    : parseNumericInput(text);
  if (value == null) {
    const hint = pending.type === 'strategy' && durationStrategyKeys.has(pending.key)
      ? 'Invalid duration. Try 45m, 1h, 1h30m, 2h, or off.'
      : 'Invalid number. Try 5, 50000, 100k, 1.5m, or off.';
    await bot.sendMessage(chatId, hint);
    return true;
  }
  pendingNumericInputs.delete(String(chatId));
  if (userMessageId) bot.deleteMessage(chatId, userMessageId).catch(() => {});
  if (pending.type === 'strategy') {
    const strat = activeStrategy();
    if (strat.id !== pending.strategyId) {
      await bot.sendMessage(chatId, 'Strategy changed while input was pending. Open Strategy menu and try again.');
      return true;
    }
    const newConfig = { ...strat, [pending.key]: value };
    delete newConfig.id;
    delete newConfig.name;
    updateStrategyConfig(strat.id, newConfig);
    const text = pending.returnMenu === 'cooldown' ? cooldownText() : strategyMenuText();
    const keyboard = pending.returnMenu === 'cooldown' ? cooldownKeyboard() : strategyKeyboard();
    if (pending.messageId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: pending.messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...keyboard,
      }).catch(() => bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard }));
    } else {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });
    }
  } else {
    const strategyNumKeys = new Set(['min_fee_claim_sol', 'min_mcap_usd', 'max_mcap_usd', 'min_gmgn_total_fee_sol', 'min_graduated_volume_usd', 'max_top20_holder_percent', 'min_saved_wallet_holders', 'trending_min_volume_usd', 'trending_min_swaps', 'trending_max_rug_ratio', 'trending_max_bundler_rate', 'trailing_floor_at_percent', 'trailing_floor_percent', 'trailing_tier_1_at_percent', 'trailing_tier_1_percent', 'trailing_tier_2_at_percent', 'trailing_tier_2_percent', 'trailing_tier_3_at_percent', 'trailing_tier_3_percent', 'trailing_tier_4_at_percent', 'trailing_tier_4_percent', 'profit_cooldown_min_profit_percent', 'profit_cooldown_max_wins', 'profit_cooldown_min_loss_percent', 'profit_cooldown_max_losses', 'profit_cooldown_minutes', 'early_exit_check_after_ms', 'early_exit_min_peak_pnl_percent', 'early_exit_max_current_pnl_percent', 'early_loss_check_after_ms', 'early_loss_window_ms', 'early_loss_exit_pnl_percent', 'sl_soft_percent', 'sl_hard_percent', 'sl_confirm_min_bad_signals', 'sl_confirm_rsi_below', 'sl_confirm_bb_below', 'sl_confirm_buy_pressure_below', 'supertrend_atr_period', 'supertrend_multiplier', 'rsi_period', 'rsi_min', 'rsi_max', 'bbrsi_overbought_rsi', 'bbrsi_max_band_pos', 'bb_buy_pressure_min_band_pos', 'bb_buy_pressure_min_ratio', 'buy_pressure_min_ratio', 'fresh_mcap_max_drop_percent', 'bb_period', 'bb_stddev']);
    if (strategyNumKeys.has(pending.key)) {
      const strat = activeStrategy();
      const newConfig = { ...strat, [pending.key]: value };
      delete newConfig.id;
      delete newConfig.name;
      updateStrategyConfig(strat.id, newConfig);
    } else {
      setSetting(pending.key, String(value));
    }
    if (pending.messageId) {
      await bot.editMessageText(filtersText(), {
        chat_id: chatId,
        message_id: pending.messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...filtersKeyboard(),
      }).catch(() => bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() }));
    } else {
      await bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() });
    }
  }
  return true;
}

async function editMenuMessage(query, text, extra = {}) {
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
