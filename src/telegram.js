import { timingSafeEqual } from 'node:crypto';
import { request } from './http.js';
import { AgentError, telegramIdentity, parseCallback, validateTweet, hash } from './domain.js';
import { regenerate } from './ai.js';

export function equalSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && Buffer.byteLength(a) === Buffer.byteLength(b)
    && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export async function telegram(config, method, body, transport = request) {
  if (!config.telegramToken) throw new AgentError('telegram_not_configured');
  const r = await transport(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { ...body, allow_paid_broadcast: false }, timeout: 15000
  });
  let result; try { result = JSON.parse(r.text); } catch { throw new AgentError('telegram_invalid_response'); }
  if (r.status !== 200 || !result.ok) throw new AgentError(`telegram_http_${r.status}`);
  return result.result;
}
export async function ingest(config, db, payload) {
  if (!equalSecret(payload?.secret, config.telegramSecret)) throw new AgentError('invalid_webhook_secret', 401);
  const identity = telegramIdentity(payload.update, config.telegramUsers, config.telegramChat);
  await db.command('ingest', { ...identity, update_id: payload.update.update_id, payload: payload.update });
  return { ok: true };
}
export async function handleUpdate(config, db, update, send = telegram, regen = regenerate) {
  const identity = telegramIdentity(update, config.telegramUsers, config.telegramChat);
  if (update.callback_query) {
    const q = update.callback_query;
    // Callback acknowledgement is best effort; it does not control approval state.
    try { await send(config, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Processing your choice' }); } catch { /* persisted update remains authoritative */ }
    const { action, id, version } = parseCallback(q.data);
    const args = { ...identity, id, version };
    const draft = await db.command('draft', { id });
    if (!draft?.id || draft.content_version !== version || String(draft.telegram_message_id) !== String(q.message.message_id)) throw new AgentError('expired_callback');
    if (action === 'approve' || action === 'reject') {
      const result = await db.command(action, args);
      await db.command('log', { workflow: 'approval', event: action, status: 'ok',
        message: result.expired ? `Draft ${id} missed its slot and was skipped.` : `Draft ${id}: ${action === 'approve' ? 'approved' : 'rejected'} (version ${version}).`,
        key: `choice:${update.update_id}`, alert: true });
    } else if (action === 'edit') {
      await db.command('begin_edit', args);
      const sent = await send(config, 'sendMessage', { chat_id: identity.chat_id,
        text: `Reply to THIS message with replacement text for ${id} (v${version}). This request expires in one hour. Previous approval is cleared.`,
        reply_markup: { force_reply: true, selective: true } });
      await db.command('edit_prompt', { ...args, prompt_id: sent.message_id });
    } else {
      await db.command('begin_regenerate', args);
      await regen(config, db, draft, identity);
    }
    return;
  }
  const message = update.message;
  if (/^\/(start|help)(?:\s|$)/.test(message?.text || '')) {
    await send(config, 'sendMessage', { chat_id: identity.chat_id,
      text: 'Your approval account is connected. Drafts will appear here with Approve, Reject, Edit, and Regenerate buttons. Editing or regenerating always requires fresh approval. Only explicitly approved versions can be queued for publishing.' });
    return;
  }
  if (!message?.reply_to_message || typeof message.text !== 'string') throw new AgentError('reply_to_edit_prompt_required');
  const session = await db.command('edit_lookup', { ...identity, prompt_id: message.reply_to_message.message_id });
  if (!session?.tweet_id) throw new AgentError('expired_edit_session');
  const context = await db.command('context');
  const validation = validateTweet(message.text, context.recent.filter(x => x.id !== session.tweet_id).map(x => x.content));
  await db.command('revise', { ...identity, id: session.tweet_id, version: session.version, content: message.text,
    content_hash: hash(message.text), validation, revision_type: 'edited' });
}
export async function processInbox(config, db, send = telegram, regen = regenerate) {
  let processed = 0;
  for (let i = 0; i < 10; i++) {
    const item = await db.command('inbox_claim');
    if (!item) break;
    try {
      await handleUpdate(config, db, item.payload, send, regen);
      await db.command('inbox_done', { id: item.update_id });
      processed++;
    } catch (error) {
      const code = error instanceof AgentError ? error.code : 'approval_state_conflict_or_database_failure';
      await db.command('log', { workflow: 'approval', event: 'update_failed', status: 'error',
        message: `${code}. Update ${item.update_id}; inspect draft and retry a fresh action if needed.`, key: `update:${item.update_id}`, alert: true });
      // Deterministic input errors should not loop. Network/DB failures retain lease for safe recovery.
      if (error instanceof AgentError && !/http_|not_configured|source_expired/.test(code)) await db.command('inbox_done', { id: item.update_id });
    }
  }
  return { processed };
}
export async function deliverOutbox(config, db, send = telegram) {
  let sent = 0;
  for (let i = 0; i < 10; i++) {
    const item = await db.command('outbox_claim');
    if (!item) break;
    try {
      const p = item.payload;
      if (p.kind === 'draft') {
        const d = await db.command('draft', { id: p.id });
        if (d.content_version !== p.version || d.status !== 'pending') { await db.command('outbox_done', { id: item.id }); continue; }
        const time = d.scheduled_at ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d.scheduled_at)) + ' IST' : 'Unscheduled manual draft (will not auto-publish)';
        const result = await send(config, 'sendMessage', { chat_id: config.telegramChat,
          text: `${d.content}\n\nCategory: ${d.category}\nScheduled: ${time}\nVersion: ${d.content_version}\nSources: ${d.source_urls.join('\n') || 'Evergreen reflection; no research claim'}\nEditorial rationale: ${d.rationale}`,
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [[['Approve', 'approve'], ['Reject', 'reject']], [['Edit', 'edit'], ['Regenerate', 'regen']]].map(row =>
            row.map(([text, action]) => ({ text, callback_data: `${action}:${d.id}:${d.content_version}` }))) } });
        await db.command('message_sent', { id: d.id, version: d.content_version, chat_id: config.telegramChat, message_id: result.message_id });
      } else {
        await send(config, 'sendMessage', { chat_id: config.telegramChat, text: p.text });
      }
      await db.command('outbox_done', { id: item.id }); sent++;
      // Stay below Telegram's single-chat send rate. Delivery is at-least-once.
      await new Promise(resolve => setTimeout(resolve, 1100));
    } catch { break; } // lease retries later, no immediate retry storm
  }
  return { sent };
}
