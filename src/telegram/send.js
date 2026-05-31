import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';
import { now, json } from '../utils.js';
import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink } from '../format.js';
import { activeStrategy, numSetting } from '../db/settings.js';
import { candidateSummary, compactCandidateLine, batchRevealSummary, formatPosition } from './format.js';
import { candidateButtons, batchRevealButtons, intentButtons } from './menus.js';
import { batchById } from '../db/decisions.js';
import { intentById } from '../db/intents.js';

export async function sendTelegram(text, extra = {}) {
  return bot.sendMessage(TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...extra,
  });
}

export async function sendCandidateAlert(candidateId, candidate, decision) {
  const sent = await sendTelegram(candidateSummary(candidate, decision), candidateButtons(candidateId, decision));
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId, candidate.token.mint, 'candidate', now(), sent.message_id, json({ candidate, decision }));
}

export async function sendBatchReveal(batchId, rows, decision, triggerCandidateId) {
  const sent = await sendTelegram(
    batchRevealSummary(batchId, rows, decision, triggerCandidateId),
    batchRevealButtons(batchId, rows, decision, triggerCandidateId),
  );
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    triggerCandidateId || null,
    decision.selected_mint || rows.find(row => row.id === Number(triggerCandidateId))?.candidate?.token?.mint || 'batch',
    'batch_reveal',
    now(),
    sent.message_id,
    json({ batchId, candidateIds: rows.map(row => row.id), decision, triggerCandidateId }),
  );
}

export async function sendBatch(chatId, batchId) {
  const batch = batchById(batchId);
  if (!batch) return bot.sendMessage(chatId, 'Batch not found.');
  const lines = [
    '🧭 <b>Screening Batch</b>',
    '',
    `Batch: <b>#${batchId}</b> · Decision: <b>${escapeHtml(batch.verdict)}</b> ${fmtPct(batch.confidence)}`,
    batch.reason ? `Reason: ${escapeHtml(String(batch.reason).slice(0, 500))}` : null,
    '',
    ...batch.rows.map((row, index) => compactCandidateLine(row, index + 1)),
  ];
  const keyboard = batch.rows.slice(0, 10).map((row, index) => ([{
    text: `${index + 1}. ${row.candidate.token?.symbol || short(row.candidate.token?.mint || '')}`,
    callback_data: `cand:${row.id}`,
  }]));
  keyboard.push([{ text: 'Open Positions', callback_data: 'menu:positions' }]);
  return bot.sendMessage(chatId, lines.filter(Boolean).join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function sendPositionOpen(positionId) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  const label = position?.execution_mode === 'live' ? 'Live buy executed' : 'Dry-run buy stored';
  if (position) await sendTelegram(`✅ <b>${label}</b>\n\n${formatPosition(position)}`);
}

export async function sendPositionExit(position) {
  const exitReason = position.exitReason || position.exit_reason || 'closed';
  await sendTelegram(formatPosition({
    ...position,
    status: 'closed',
    exitReason,
    exit_reason: exitReason,
  }));
}

export async function sendTradeIntent(intentId, candidate, decision) {
  const intent = intentById(intentId);
  const strat = activeStrategy();
  const sizeSol = Number(intent?.size_sol ?? intent?.payload?.strategy?.position_size_sol ?? strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1));
  await sendTelegram([
    '🧾 <b>Trade intent awaiting confirmation</b>',
    '',
    candidateSummary(candidate, decision),
    '',
    `Size: <b>${fmtSol(sizeSol)} SOL</b>`,
    'Execution: confirmation required before signing.',
  ].join('\n'), intentButtons(intentId));
}
