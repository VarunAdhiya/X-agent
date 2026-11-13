import { createHash } from 'node:crypto';
import twitterText from 'twitter-text';

export const categories = ['technology', 'ai', 'engineering', 'startups', 'psychology', 'emotions', 'growth', 'career'];
export const humanCategories = new Set(['psychology', 'emotions', 'growth', 'career']);
export class AgentError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const hash = text => createHash('sha256').update(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
export const istDay = (now = new Date()) => new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
export const schedule = (day, slot) => new Date(`${day}T${['10', '13', '16', '19', '22'][slot]}:00:00+05:30`).toISOString();
export function canonicalUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new AgentError('unsafe_source_url');
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href;
}
export function similarity(a, b) {
  const words = s => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 2));
  const x = words(a), y = words(b);
  const overlap = [...x].filter(w => y.has(w)).length;
  return overlap / Math.max(1, new Set([...x, ...y]).size);
}
export function validateTweet(text, previous = []) {
  if (typeof text !== 'string' || text !== text.trim() || !text.length) throw new AgentError('empty_or_untrimmed_tweet');
  const parsed = twitterText.parseTweet(text);
  if (!parsed.valid || parsed.weightedLength > 270) throw new AgentError('tweet_too_long_or_invalid');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/u.test(text)) throw new AgentError('unsafe_control_characters');
  if (previous.some(p => hash(p) === hash(text) || similarity(p, text) >= 0.78)) throw new AgentError('duplicate_content');
  return { valid: true, weighted_length: parsed.weightedLength, max_weighted_length: 270,
    duplicate_check: '14-day lexical similarity and all-time exact hash', factuality: 'human_review_required' };
}
export function validateGenerated(row, topic, previous) {
  if (!row || row.topic_id !== topic.id || row.category !== topic.category || typeof row.rationale !== 'string' || row.rationale.length > 700) throw new AgentError('invalid_ai_schema');
  const validation = validateTweet(row.content, previous);
  if (!Array.isArray(row.source_urls) || row.source_urls.length > 4 || !Array.isArray(row.claims)) throw new AgentError('invalid_ai_sources');
  const evidence = topic.evidence?.text || '';
  const allowed = [topic.source_url, topic.evidence?.url].filter(Boolean);
  if (row.source_urls.some(url => !allowed.includes(url))) throw new AgentError('invented_source');
  if (topic.source !== 'evergreen' && !row.source_urls.length) throw new AgentError('missing_source');
  if (row.claims.length > 5) throw new AgentError('too_many_claims');
  for (const claim of row.claims) {
    if (!claim || typeof claim.excerpt !== 'string' || claim.excerpt.length < 15 || !allowed.includes(claim.source_url) || !evidence.includes(claim.excerpt)) throw new AgentError('unsupported_claim');
  }
  if (/\d|research (shows|proves)|stud(y|ies) (shows?|finds?|found)|according to/i.test(row.content) && !row.claims.length) throw new AgentError('claim_needs_evidence');
  if (/\bI (built|shipped|worked|learned|spent|made|lost|earned)|\bmy (team|company|startup|client)\b/i.test(row.content)) throw new AgentError('unverified_personal_experience');
  // Detect copied clauses; lexical checks are a filter, not a plagiarism guarantee.
  const words = row.content.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const normalizedEvidence = (evidence.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
  for (let i = 0; i + 12 <= words.length; i++) if (normalizedEvidence.includes(words.slice(i, i + 12).join(' '))) throw new AgentError('copied_source_passage');
  return validation;
}
export function diverseCandidates(ranked, limit = 8) {
  const seen = new Set();
  const first = [], rest = [];
  for (const topic of ranked) {
    if (seen.has(topic.category)) rest.push(topic);
    else { seen.add(topic.category); first.push(topic); }
  }
  return [...first, ...rest].slice(0, limit);
}
export function validateBatch(rows, topics, recent) {
  if (!Array.isArray(rows) || rows.length !== 5) throw new AgentError('exactly_five_required');
  if (new Set(rows.map(x => x.topic_id)).size !== 5 || new Set(rows.map(x => x.category)).size < 4) throw new AgentError('insufficient_diversity');
  const humans = rows.filter(x => humanCategories.has(x.category)).length;
  if (humans < 2 || humans > 3) throw new AgentError('unbalanced_categories');
  const seen = recent.map(x => x.content);
  return rows.map((row, slot) => {
    const topic = topics.find(t => t.id === row.topic_id);
    if (!topic) throw new AgentError('unknown_ai_topic');
    const validation = validateGenerated(row, topic, seen);
    seen.push(row.content);
    return { ...row, slot, validation, content_hash: hash(row.content) };
  });
}
export function telegramIdentity(update, allowed, chatId) {
  if (!update || !Number.isSafeInteger(update.update_id)) throw new AgentError('invalid_update');
  const message = update.callback_query?.message || update.message;
  const sender = update.callback_query?.from || update.message?.from;
  if (!sender || sender.is_bot || !allowed.includes(String(sender.id)) || String(message?.chat?.id) !== chatId || message?.chat?.type !== 'private') throw new AgentError('unauthorized', 403);
  return { actor: String(sender.id), chat_id: chatId };
}
export function parseCallback(value) {
  const m = /^(approve|reject|edit|regen):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9][0-9]{0,5})$/.exec(value || '');
  if (!m) throw new AgentError('invalid_callback');
  return { action: m[1], id: m[2], version: Number(m[3]) };
}
