import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTweet, validateBatch, telegramIdentity, parseCallback, canonicalUrl, schedule, istDay, hash, diverseCandidates } from '../src/domain.js';
import { normalize, shortlist, parseFeed, discover } from '../src/discovery.js';
import { isPublicAddress } from '../src/http.js';
import { gemini } from '../src/ai.js';
import { sendToX, publishingGate, oauthHeader } from '../src/publishing.js';
import { equalSecret } from '../src/telegram.js';

test('high-ranked single-category feeds cannot crowd out evergreen categories', () => {
  const ranked = Array.from({ length: 12 }, (_, id) => ({ id, category: 'psychology' }));
  ranked.push({ id: 12, category: 'emotions' }, { id: 13, category: 'career' }, { id: 14, category: 'growth' });
  const selected = diverseCandidates(ranked);
  assert.equal(selected.length, 8);
  assert.equal(new Set(selected.map(t => t.category)).size, 4);
  assert.deepEqual(selected.slice(0, 4).map(t => t.id), [0, 12, 13, 14]);
  assert.equal(ranked.length, 15);
});

test('X weighted lengths handle CJK, emoji, and URL shortening', () => {
  assert.equal(validateTweet('你'.repeat(135)).weighted_length, 270);
  assert.throws(() => validateTweet('你'.repeat(136)), /long/);
  assert.equal(validateTweet('😀'.repeat(135)).weighted_length, 270);
  assert.throws(() => validateTweet('a'.repeat(271)), /long/);
  assert.equal(validateTweet('https://example.com/' + 'a'.repeat(200)).weighted_length, 23);
  assert.throws(() => validateTweet(''), /empty/);
  assert.throws(() => validateTweet('hello\u202Eworld'), /invalid|control/);
});
test('exact and near duplicate tweets are rejected', () => {
  assert.throws(() => validateTweet('Shipping a smaller feature makes feedback easier to understand.', ['Shipping a smaller feature makes feedback easier to understand!']), /duplicate/);
  assert.equal(hash(' Hello   WORLD '), hash('hello world'));
});
test('IST day rolls over at 18:30 UTC and publishing slots are explicit', () => {
  assert.equal(istDay(new Date('2026-11-08T18:30:00Z')), '2026-11-09');
  assert.equal(schedule('2026-11-09', 0), '2026-11-09T04:30:00.000Z');
  assert.equal(schedule('2026-11-09', 4), '2026-11-09T16:30:00.000Z');
});
test('Telegram allowlist, private chat, bot and callback input checks', () => {
  const u = { update_id: 1, message: { from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' } } };
  assert.equal(telegramIdentity(u, ['42'], '42').actor, '42');
  assert.throws(() => telegramIdentity(u, ['43'], '42'), /unauthorized/);
  u.message.chat.type = 'group';
  assert.throws(() => telegramIdentity(u, ['42'], '42'), /unauthorized/);
  assert.throws(() => parseCallback('approve:not-a-uuid:1'), /callback/);
  assert(equalSecret('secret', 'secret'));
  assert(!equalSecret('', ''));
  assert(!equalSecret('short', 'longer'));
});
test('source normalization, freshness, canonicalization and 14-day dedupe', () => {
  const now = new Date('2026-11-09T01:30:00Z');
  const raw = { title: 'A new compiler design', category: 'engineering', source: 'HN', source_url: 'https://example.org/story?utm_source=hn', published_at: now.toISOString() };
  const normalized = normalize(raw, now);
  assert.equal(normalized.source_url, 'https://example.org/story');
  assert.equal(normalize({ ...raw, published_at: '2020-01-01' }, now), null);
  assert.equal(normalize({ ...raw, published_at: 'invalid' }, now), null);
  assert.equal(shortlist([normalized, normalized], { topics: [], recent: [] }).length, 1);
  assert.equal(shortlist([normalized], { topics: [{ ...normalized, id: 'old' }], recent: [{ topic_id: 'old' }] }).length, 0);
  assert.throws(() => canonicalUrl('http://example.com'), /unsafe/);
  assert.throws(() => canonicalUrl('https://user:pass@example.com'), /unsafe/);
});
test('RSS/Atom parsing and XML entity rejection', () => {
  const source = { url: 'https://example.org/rss', category: 'ai' };
  assert.equal(parseFeed('<rss><channel><item><title>Title</title><link>https://example.org/a</link><pubDate>2026-11-09</pubDate></item></channel></rss>', source)[0].source_url, 'https://example.org/a');
  assert.equal(parseFeed('<feed><entry><title>A</title><link href="https://example.org/b"/><updated>2026-11-09</updated></entry></feed>', source)[0].source_url, 'https://example.org/b');
  assert.throws(() => parseFeed('<!DOCTYPE x><rss/>', source), /unsafe_xml/);
});
test('SSRF blocks metadata, localhost, mapped IPv4 and private ranges', () => {
  for (const ip of ['127.0.0.1','10.1.1.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','fc00::1','0.0.0.0']) assert(!isPublicAddress(ip), ip);
  assert(isPublicAddress('1.1.1.1'));
});
test('topic-source failure is isolated; insufficient evidence fails closed', async () => {
  const logs = [];
  const db = { async command(op, p) {
    if (op === 'context') return { settings: { generation_enabled: true }, day: '2026-11-09', topics: [], recent: [] };
    if (op === 'log') logs.push(p); return {};
  } };
  const cfg = { sources: { feeds: [{ url: 'https://unavailable.example/rss' }], evergreen: [] } };
  await assert.rejects(discover(cfg, db, async () => { throw new Error('down'); }), /insufficient/);
  assert.equal(logs.length, 2);
});
test('Gemini free tier gate prevents any HTTP call', async () => {
  let calls = 0;
  await assert.rejects(gemini({ freeTierConfirmed: false }, {}, '', 5, async () => calls++), /free_tier/);
  assert.equal(calls, 0);
});
test('invalid JSON, truncated output, and wrong AI cardinality are rejected', async () => {
  const c = { freeTierConfirmed: true, geminiKey: 'mock', geminiModel: 'mock' };
  const db = { command: async () => ({}) };
  for (const body of ['not json', JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }),
    JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] })]) {
    await assert.rejects(gemini(c, db, '', 5, async () => ({ status: 200, text: body })), /invalid_ai/);
  }
  assert.throws(() => validateBatch([], [], []), /five/);
});
test('live posting requires all opt-ins and credentials', () => {
  assert.equal(publishingGate({ dryRun: false }, {}), 'x_publishing_disabled');
  assert.equal(publishingGate({ dryRun: false, publishingEnabled: true, xCostAccepted: true }, { publishing_enabled: true }), 'x_credentials_missing');
  assert.equal(publishingGate({ dryRun: true }, { paused: true }), 'globally_paused');
  assert.equal(publishingGate({ dryRun: true }, {}), null);
});
const live = { dryRun: false, publishingEnabled: true, xCostAccepted: true, xConsumerKey: 'k', xConsumerSecret: 's', xAccessToken: 't', xAccessSecret: 's' };
test('X 429 is a definite failure; timeouts, 5xx and malformed success are uncertain; never retries', async () => {
  const cases = [[429, '{}', 'failed'], [503, '{}', 'uncertain'], [201, '{}', 'uncertain'], [201, 'bad json', 'uncertain'], [201, '{"data":{"id":"1234"}}', 'published']];
  for (const [status, text, state] of cases) {
    let calls = 0;
    const result = await sendToX(live, { content: 'A useful question can change the shape of a problem.' }, async () => { calls++; return { status, text }; });
    assert.equal(result.state, state); assert.equal(calls, 1);
  }
  assert.equal((await sendToX(live, { content: 'A timeout requires reconciliation.' }, async () => { throw new Error('timeout'); })).state, 'uncertain');
});
test('dry-run never invokes an X transport and OAuth uses user context', async () => {
  let called = false;
  assert.equal((await sendToX({ dryRun: true }, { content: 'This is a dry run.' }, async () => { called = true; })).state, 'simulated');
  assert(!called);
  const authorization = oauthHeader(live, 'fixed-nonce', 123456);
  assert.match(authorization, /^OAuth /);
  assert.match(authorization, /oauth_token="t"/);
  assert.match(authorization, /oauth_signature=/);
});
