import { createHmac, randomBytes } from 'node:crypto';
import { request } from './http.js';
import { AgentError, validateTweet, istDay } from './domain.js';

const endpoint = 'https://api.x.com/2/tweets';
const encode = s => encodeURIComponent(s).replace(/[!'()*]/g, x => `%${x.charCodeAt(0).toString(16).toUpperCase()}`);
export function oauthHeader(config, nonce = randomBytes(24).toString('hex'), timestamp = Math.floor(Date.now() / 1000)) {
  const params = { oauth_consumer_key: config.xConsumerKey, oauth_token: config.xAccessToken,
    oauth_nonce: nonce, oauth_timestamp: String(timestamp), oauth_signature_method: 'HMAC-SHA1', oauth_version: '1.0' };
  const normalized = Object.keys(params).sort().map(k => `${encode(k)}=${encode(params[k])}`).join('&');
  const base = `POST&${encode(endpoint)}&${encode(normalized)}`;
  params.oauth_signature = createHmac('sha1', `${encode(config.xConsumerSecret)}&${encode(config.xAccessSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.keys(params).sort().map(k => `${encode(k)}="${encode(params[k])}"`).join(', ');
}
export function publishingGate(config, settings) {
  if (settings.paused) return 'globally_paused';
  if (config.dryRun) return null;
  if (!config.publishingEnabled || !settings.publishing_enabled || !config.xCostAccepted) return 'x_publishing_disabled';
  if (![config.xConsumerKey, config.xConsumerSecret, config.xAccessToken, config.xAccessSecret].every(Boolean)) return 'x_credentials_missing';
  return null;
}
export async function sendToX(config, draft, transport = request) {
  validateTweet(draft.content);
  if (config.dryRun) return { state: 'simulated' };
  if (!config.publishingEnabled || !config.xCostAccepted || ![config.xConsumerKey, config.xConsumerSecret, config.xAccessToken, config.xAccessSecret].every(Boolean)) throw new AgentError('x_disabled');
  try {
    const r = await transport(endpoint, { method: 'POST', headers: { Authorization: oauthHeader(config), 'Content-Type': 'application/json' },
      body: { text: draft.content }, timeout: 15000, maxBytes: 10000 });
    if (r.status === 201) {
      const data = JSON.parse(r.text);
      if (!/^\d+$/.test(data?.data?.id || '')) return { state: 'uncertain', error_code: 'x_success_without_id' };
      return { state: 'published', x_post_id: data.data.id };
    }
    // Definite refusals are terminal and require human action; no automatic X retries.
    if ([400,401,403,404,422,429].includes(r.status)) return { state: 'failed', error_code: `x_http_${r.status}` };
    return { state: 'uncertain', error_code: `x_http_${r.status}` };
  } catch { return { state: 'uncertain', error_code: 'x_transport_or_response_ambiguous' }; }
}
export async function publish(config, db, transport = request) {
  // Poll only the tiny settings row, not article excerpts; this matters for
  // Supabase's free egress allowance at one poll per minute.
  const settings = await db.command('settings');
  const blocked = publishingGate(config, settings);
  if (blocked) {
    if (blocked !== 'globally_paused') await db.command('log', { workflow: 'publishing', event: blocked, status: 'blocked',
      message: 'Live publishing unavailable. Approved drafts remain queued; missed slots will not auto-publish.',
      key: `publishing-disabled:${istDay()}`, alert: true });
    return { blocked };
  }
  const claimed = await db.command('claim', { mode: config.dryRun ? 'dry' : 'live' });
  if (!claimed) return { claimed: false };
  // A crash from this point onward is uncertain, even if it occurs before HTTP.
  // This deliberately favors a missed post over a duplicate post.
  const { draft, attempt } = claimed;
  if (draft.approved_version !== draft.content_version || draft.approved_content !== draft.content) throw new AgentError('approval_version_mismatch');
  const outcome = await sendToX(config, draft, transport);
  await db.command('finish', { attempt_id: attempt.id, ...outcome });
  return { id: draft.id, ...outcome };
}
