import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { hash } from '../src/domain.js';
import { generate } from '../src/ai.js';
import { publish } from '../src/publishing.js';
import { ingest, handleUpdate, processInbox } from '../src/telegram.js';
import { createApp } from '../src/server.js';

let pg, db;
const migrationDir = new URL('../supabase/migrations/', import.meta.url);
const migration = readdirSync(migrationDir).filter(x => x.endsWith('.sql')).sort().map(x => readFileSync(new URL(x, migrationDir), 'utf8')).join('\n');
const config = { dryRun: true, internalToken: 'i'.repeat(32), telegramSecret: 's'.repeat(32), telegramUsers: ['42'], telegramChat: '42', style: {} };
const identity = { actor: '42', chat_id: '42' };
const texts = [
  'A smaller API surface gives a team fewer promises to keep.',
  'The useful question for an AI tool: which decisions still need your attention?',
  'A product can be simple for its users and difficult for its builders. That tradeoff deserves respect.',
  'A difficult feeling can deserve attention without getting the final vote.',
  'Career growth can mean choosing work you want to become better at, even when the title stays the same.'
];
const cats = ['engineering', 'ai', 'startups', 'emotions', 'career'];
async function admin(sql, params) {
  await pg.exec('reset role');
  try { return await pg.query(sql, params); } finally { await pg.exec('set role agent_runtime'); }
}
before(async () => {
  pg = new PGlite();
  await pg.exec(migration);
  await pg.exec('set role agent_runtime');
  db = { command: async (op, p = {}) => (await pg.query('select agent.command($1,$2::jsonb) result', [op, JSON.stringify(p)])).rows[0].result };
});
after(async () => { await pg?.close(); });
beforeEach(async () => {
  await admin(`truncate agent.topics,agent.generation_runs,agent.tweet_drafts,agent.tweet_revisions,
    agent.publication_attempts,agent.automation_logs,agent.inbox,agent.outbox,agent.edit_sessions,agent.api_usage restart identity cascade`);
  await admin("update agent.automation_settings set publishing_enabled=false,generation_enabled=true,paused=false,telegram_user_ids=array['42'],telegram_chat_id='42',daily_post_limit=5");
});
async function seed() {
  await db.command('topics', { topics: cats.map((category, i) => ({ title: `Editorial seed topic ${i}`, category, source: 'evergreen',
    source_url: null, fingerprint: hash(`seed ${i}`), relevance_score: i, evidence: { type: 'editorial_prompt_not_research' } })) });
  const ctx = await db.command('context');
  const topics = cats.map(c => ctx.topics.find(t => t.category === c));
  await generate(config, db, async () => topics.map((t, i) => ({ topic_id: t.id, category: t.category, content: texts[i], source_urls: [], claims: [], rationale: 'A concrete editorial perspective.' })));
  const result = await admin('select * from agent.tweet_drafts order by slot');
  // Fixtures isolate state-machine behavior from the wall clock. Production has no clock override.
  await admin("update agent.tweet_drafts set scheduled_at=now()+interval '1 day'+slot*interval '1 hour'");
  for (const d of result.rows) await db.command('message_sent', { id: d.id, version: 1, chat_id: '42', message_id: 100 + d.slot });
  return result.rows;
}
async function approve(d) { return db.command('approve', { ...identity, id: d.id, version: d.content_version }); }
async function due(d) {
  await admin("update agent.tweet_drafts set scheduled_at=now()-interval '1 minute',approved_at=now()-interval '2 minutes' where id=$1", [d.id]);
}
function callback(d, action = 'approve', update_id = 101) {
  return { update_id, callback_query: { id: `cb-${update_id}`, data: `${action}:${d.id}:${d.content_version}`,
    from: { id: 42, is_bot: false }, message: { message_id: 100 + d.slot, chat: { id: 42, type: 'private' } } } };
}

test('migration, least-privilege access and atomic exactly-five generation', async () => {
  const drafts = await seed();
  assert.equal(drafts.length, 5);
  assert(drafts.every(d => d.status === 'pending'));
  await assert.rejects(pg.query('select * from agent.tweet_drafts'), /permission/);
  await assert.rejects(pg.query("update agent.tweet_drafts set status='approved'"), /permission/);
  assert.equal((await db.command('generation_start')).skipped, true);
  assert.equal((await admin('select count(*)::int n from agent.tweet_revisions')).rows[0].n, 5);
});
test('invalid batch inserts no partial drafts and can be rerun', async () => {
  const run = await db.command('generation_start');
  await assert.rejects(db.command('generation_save', { token: run.token, drafts: [] }), /five/);
  await assert.rejects(db.command('generation_save', { token: run.token }), /five/);
  assert.equal((await admin('select count(*)::int n from agent.tweet_drafts')).rows[0].n, 0);
  await db.command('generation_fail', { token: run.token });
  assert((await db.command('generation_start')).token);
});

test('manual batches add five unscheduled drafts, dedupe retries, preserve scheduled batch', async () => {
  const original = await seed();
  for (const request_id of ['manual:1', 'manual:2']) {
    const run = await db.command('generation_start', { mode: 'manual', request_id });
    const drafts = original.map((d, slot) => ({ ...d, slot, content: `${request_id} unique content ${slot}`,
      content_hash: hash(`${request_id}:${slot}`), validation: { valid: true } }));
    await db.command('generation_save', { token: run.token, drafts });
    assert.equal((await db.command('generation_start', { mode: 'manual', request_id })).skipped, true);
    await assert.rejects(db.command('generation_save', { token: run.token, drafts }), /lease/);
  }
  assert.equal((await admin('select count(*)::int n from agent.tweet_drafts')).rows[0].n, 15);
  assert.equal((await admin('select count(*)::int n from agent.tweet_drafts where scheduled_at is null')).rows[0].n, 10);
  assert.equal((await db.command('generation_start')).skipped, true);
  await assert.rejects(db.command('generation_start', { mode: 'manual' }), /request ID/);
  const [d] = (await admin('select * from agent.tweet_drafts where scheduled_at is null limit 1')).rows;
  await approve(d);
  assert.equal(await db.command('claim', { mode: 'dry' }), null);
});
test('approval verifies actor, chat, exact version; reject cannot publish', async () => {
  const [d] = await seed();
  for (const extra of [{ actor: '43' }, { chat_id: '99' }, { actor: null }, { version: 2 }, { version: null }]) {
    await assert.rejects(db.command('approve', { ...identity, id: d.id, version: 1, ...extra }), /unauthorized|expired/);
  }
  await approve(d); await approve(d);
  await db.command('reject', { ...identity, id: d.id, version: 1 });
  await due(d);
  assert.equal(await db.command('claim', { mode: 'dry' }), null);
  await assert.rejects(approve(d), /locked/);
});
test('Telegram edit reply maps to the correct prompt, revises history, and requires new approval', async () => {
  const [d] = await seed(); await approve(d);
  await handleUpdate(config, db, callback(d, 'edit'), async (_c, method) => method === 'sendMessage' ? { message_id: 999 } : {});
  let current = await db.command('draft', { id: d.id });
  assert.equal(current.status, 'editing'); assert.equal(current.approved_version, null);
  await assert.rejects(approve(d), /progress/);
  await handleUpdate(config, db, { update_id: 102, message: { from: { id: 42 }, chat: { id: 42, type: 'private' },
    reply_to_message: { message_id: 999 }, text: 'An interface is also a list of promises someone will need to maintain.' } });
  current = await db.command('draft', { id: d.id });
  assert.equal(current.status, 'pending'); assert.equal(current.content_version, 2);
  assert.equal(current.approved_at, null);
  await assert.rejects(approve(d), /expired/);
  await approve(current);
  assert.equal((await admin('select count(*)::int n from agent.tweet_revisions where tweet_id=$1', [d.id])).rows[0].n, 2);
});
test('regenerate invalidates previous approval and commits a new version', async () => {
  const [d] = await seed(); await approve(d);
  const { regenerate } = await import('../src/ai.js');
  await handleUpdate(config, db, callback(d, 'regen'), async () => ({}), async (c, database, draft, who) => regenerate(c, database, draft, who,
    async () => [{ topic_id: draft.topic_id, category: draft.category, content: 'The best abstraction often makes a future decision easier to reverse.',
      source_urls: [], claims: [], rationale: 'Alternative angle.' }]));
  const current = await db.command('draft', { id: d.id });
  assert.equal(current.status, 'pending'); assert.equal(current.content_version, 2); assert.equal(current.approved_version, null);
});
test('durable inbox deduplicates Telegram updates and enforces webhook secret', async () => {
  const [d] = await seed(); const update = callback(d);
  await assert.rejects(ingest(config, db, { secret: 'bad', update }), /secret/);
  await ingest(config, db, { secret: config.telegramSecret, update });
  await ingest(config, db, { secret: config.telegramSecret, update });
  assert.equal((await admin('select count(*)::int n from agent.inbox')).rows[0].n, 1);
  await processInbox(config, db, async () => ({}));
  assert.equal((await db.command('draft', { id: d.id })).status, 'approved');
  assert.equal((await processInbox(config, db, async () => ({}))).processed, 0);
});
test('start command acknowledges only the allowlisted account and changes no drafts', async () => {
  const [draft] = await seed();
  const update = { update_id: 103, message: { from: { id: 42, is_bot: false },
    chat: { id: 42, type: 'private' }, text: '/start' } };
  const sends = [];
  const send = async (_config, method, payload) => { sends.push({ method, payload }); return { message_id: 700 }; };
  await ingest(config, db, { secret: config.telegramSecret, update });
  assert.equal((await processInbox(config, db, send)).processed, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].payload.chat_id, '42');
  const unchanged = await db.command('draft', { id: draft.id });
  assert.equal(unchanged.status, 'pending');
  assert.equal(unchanged.approved_at, null);
  await assert.rejects(handleUpdate(config, db, { ...update,
    message: { ...update.message, from: { id: 99 }, chat: { id: 99, type: 'private' } } }, send), /unauthorized/);
  assert.equal(sends.length, 1);
});

test('late approvals expire and old scheduled approvals never catch up', async () => {
  const [a, b] = await seed();
  await due(a);
  assert((await approve(a)).expired);
  await approve(b);
  await admin("update agent.tweet_drafts set scheduled_at=now()-interval '10 minutes' where id=$1", [b.id]);
  assert.equal(await db.command('claim', { mode: 'dry' }), null);
  assert.equal((await db.command('draft', { id: b.id })).status, 'expired');
});
test('scheduled claim is exclusive; future and unapproved drafts stay untouched', async () => {
  const [d] = await seed();
  assert.equal(await db.command('claim', { mode: 'dry' }), null);
  await approve(d);
  assert.equal(await db.command('claim', { mode: 'dry' }), null);
  await due(d);
  const results = await Promise.all([db.command('claim', { mode: 'dry' }), db.command('claim', { mode: 'dry' })]);
  assert.equal(results.filter(Boolean).length, 1);
  await assert.rejects(db.command('begin_edit', { ...identity, id: d.id, version: 1 }), /locked/);
});
test('global pause and database publishing-off prevent live claims', async () => {
  const [d] = await seed(); await approve(d); await due(d);
  assert.equal(await db.command('claim', { mode: 'live' }), null);
  await admin('update agent.automation_settings set paused=true');
  assert.equal(await db.command('claim', { mode: 'dry' }), null);
});
test('full generated draft → Telegram approval → actual local mock HTTP X server → recorded ID', async () => {
  const [d] = await seed();
  await ingest(config, db, { secret: config.telegramSecret, update: callback(d) });
  await processInbox(config, db, async () => ({}));
  await due(d); await admin('update agent.automation_settings set publishing_enabled=true');
  const { createServer } = await import('node:http');
  let calls = 0;
  const mock = createServer(async (req, res) => {
    calls++; let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).text, d.content);
    assert.match(req.headers.authorization, /^OAuth /);
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"data":{"id":"987654321"}}');
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const c = { ...config, dryRun: false, publishingEnabled: true, xCostAccepted: true,
    xConsumerKey: 'mock', xConsumerSecret: 'mock', xAccessToken: 'mock', xAccessSecret: 'mock' };
  try {
    const transport = async (url, opts) => {
      assert.equal(url, 'https://api.x.com/2/tweets');
      const r = await fetch(`http://127.0.0.1:${mock.address().port}/2/tweets`, { method: opts.method, headers: opts.headers, body: JSON.stringify(opts.body) });
      return { status: r.status, text: await r.text() };
    };
    assert.equal((await publish(c, db, transport)).state, 'published');
    assert.equal((await publish(c, db, transport)).claimed, false);
    const saved = await db.command('draft', { id: d.id });
    assert.equal(saved.x_post_id, '987654321'); assert.equal(saved.status, 'published'); assert.equal(calls, 1);
  } finally { await new Promise(resolve => mock.close(resolve)); }
});
test('dry-run records simulated outcome with no X ID', async () => {
  const [d] = await seed(); await approve(d); await due(d);
  const result = await publish(config, db, () => { throw new Error('must not reach transport'); });
  assert.equal(result.state, 'simulated');
  const saved = await db.command('draft', { id: d.id });
  assert.equal(saved.x_post_id, null); assert.equal(saved.published_at, null);
});
test('missing credentials keep approved drafts queued without a claim', async () => {
  const [d] = await seed(); await approve(d); await due(d);
  await admin('update agent.automation_settings set publishing_enabled=true');
  const result = await publish({ ...config, dryRun: false, publishingEnabled: true, xCostAccepted: true }, db);
  assert.equal(result.blocked, 'x_credentials_missing');
  assert.equal((await db.command('draft', { id: d.id })).status, 'approved');
});
test('ambiguous attempts reserve daily capacity and are never automatically retried', async () => {
  const drafts = await seed();
  for (const d of drafts) {
    await approve(d); await due(d);
    const claim = await db.command('claim', { mode: 'dry' });
    await db.command('finish', { attempt_id: claim.attempt.id, state: 'uncertain', error_code: 'test_ambiguity' });
  }
  assert.equal(await db.command('claim', { mode: 'dry' }), null);
  assert.equal((await admin("select count(*)::int n from agent.publication_attempts where state='uncertain'")).rows[0].n, 5);
  // Add a sixth otherwise eligible fixture to prove the budget itself blocks it,
  // rather than merely exhausting the five original rows.
  await admin("insert into agent.generation_runs(day,state) values((now() at time zone 'Asia/Kolkata')::date-1,'complete')");
  await admin(`insert into agent.tweet_drafts(topic_id,generation_day,generation_run_id,slot,content,content_hash,category,status,
    scheduled_at,approved_at,approved_version,approved_content,approved_by,rationale,validation)
    values($1,(now() at time zone 'Asia/Kolkata')::date-1,(select id from agent.generation_runs where day=(now() at time zone 'Asia/Kolkata')::date-1),0,'Sixth capacity fixture',$2,'engineering','approved',
    now()-interval '30 seconds',now()-interval '2 minutes',1,'Sixth capacity fixture','42','test','{"valid":true}')`,
  [drafts[0].topic_id, hash('Sixth capacity fixture')]);
  assert.equal(await db.command('claim', { mode: 'dry' }), null);
});
test('database check constraints prevent mismatched approval and missing publication IDs', async () => {
  const [d] = await seed(); await approve(d);
  await assert.rejects(admin("update agent.tweet_drafts set content_version=2 where id=$1", [d.id]), /check constraint/);
  await assert.rejects(admin("update agent.tweet_drafts set approved_version=null where id=$1", [d.id]), /check constraint/);
  await assert.rejects(admin("update agent.tweet_drafts set status='published' where id=$1", [d.id]), /check constraint/);
});
test('article headline changes do not abort topic persistence', async () => {
  const base = { title: 'A compiler announcement', category: 'engineering', source: 'rss', source_url: 'https://example.org/compiler',
    fingerprint: hash('headline one'), published_at: new Date().toISOString(), relevance_score: 1 };
  await db.command('topics', { topics: [base] });
  await db.command('topics', { topics: [{ ...base, title: 'Changed headline', fingerprint: hash('headline two') }] });
  assert.equal((await admin('select count(*)::int n from agent.topics')).rows[0].n, 1);
});
test('Gemini usage is tracked without a daily cap; rapid calls remain paced', async () => {
  await db.command('gemini_budget');
  await assert.rejects(db.command('gemini_budget'), /quota|pacing/);
  await admin("update agent.api_usage set gemini_calls=1000,last_call_at=now()-interval '1 minute'");
  await db.command('gemini_budget');
  assert.equal((await admin('select gemini_calls from agent.api_usage')).rows[0].gemini_calls, 1001);
});
test('network errors persist terminal X outcomes without releasing them for retry', async () => {
  const [a, b] = await seed();
  await admin('update agent.automation_settings set publishing_enabled=true');
  const c = { ...config, dryRun: false, publishingEnabled: true, xCostAccepted: true, xConsumerKey: 'm', xConsumerSecret: 'm', xAccessToken: 'm', xAccessSecret: 'm' };
  for (const [d, status, expected] of [[a, 429, 'failed'], [b, 503, 'uncertain']]) {
    await approve(d); await due(d);
    let calls = 0;
    assert.equal((await publish(c, db, async () => { calls++; return { status, text: '{}' }; })).state, expected);
    assert.equal((await db.command('draft', { id: d.id })).status, expected);
    assert.equal((await publish(c, db, async () => { calls++; })).claimed, false);
    assert.equal(calls, 1);
  }
});
test('stuck publishing is marked uncertain and edit recovery never restores approval', async () => {
  const [a, b] = await seed(); await approve(a); await due(a);
  await db.command('claim', { mode: 'dry' });
  await admin("update agent.publication_attempts set started_at=now()-interval '3 minutes'");
  await approve(b); await db.command('begin_edit', { ...identity, id: b.id, version: 1 });
  await admin("update agent.tweet_drafts set updated_at=now()-interval '2 hours' where id=$1", [b.id]);
  await db.command('monitor');
  assert.equal((await db.command('draft', { id: a.id })).status, 'uncertain');
  const recovered = await db.command('draft', { id: b.id });
  assert.equal(recovered.status, 'pending'); assert.equal(recovered.approved_version, null);
});
test('repeated logs deduplicate alerts', async () => {
  const data = { workflow: 'test', event: 'failure', status: 'error', message: 'sanitized', key: 'same', alert: true };
  await db.command('log', data); await db.command('log', data);
  assert.equal((await admin('select count(*)::int n from agent.automation_logs')).rows[0].n, 1);
  assert.equal((await admin('select count(*)::int n from agent.outbox')).rows[0].n, 1);
});
test('internal HTTP API requires authentication and rejects malformed input', async () => {
  const app = createApp(config, db); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(url + '/publish', { method: 'POST' })).status, 401);
    assert.equal((await fetch(url + '/publish', { method: 'POST', headers: { 'x-agent-token': config.internalToken }, body: '{' })).status, 400);
    assert.equal((await fetch(url + '/health')).status, 200);
  } finally { await new Promise(resolve => app.close(resolve)); }
});
test('PostgreSQL data and approvals survive an embedded database restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-agent-pg-'));
  let disk = new PGlite(dir);
  try {
    await disk.exec(migration);
    await disk.exec("insert into agent.automation_logs(workflow_name,event_type,status) values('restart','persisted','ok')");
    await disk.exec(`update agent.automation_settings set telegram_user_ids=array['42'],telegram_chat_id='42';
      insert into agent.topics(id,title,category,source,fingerprint) values('00000000-0000-4000-8000-000000000001','Restart fixture','career','evergreen','fixture');
      insert into agent.generation_runs(day,state) values((now() at time zone 'Asia/Kolkata')::date,'complete');
      insert into agent.tweet_drafts(id,topic_id,generation_day,generation_run_id,slot,content,content_hash,category,scheduled_at,rationale,validation)
      values('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',
        (now() at time zone 'Asia/Kolkata')::date,(select id from agent.generation_runs limit 1),0,'Persistent approval fixture','fixture-hash','career',now()+interval '1 day','test','{"valid":true}');
      select agent.command('approve','{"actor":"42","chat_id":"42","id":"00000000-0000-4000-8000-000000000002","version":1}');`);
    await disk.close(); disk = new PGlite(dir);
    assert.equal((await disk.query("select count(*)::int n from agent.automation_logs where event_type='persisted'")).rows[0].n, 1);
    const saved = (await disk.query('select status,approved_version,approved_content from agent.tweet_drafts')).rows[0];
    assert.equal(saved.status, 'approved'); assert.equal(saved.approved_version, 1); assert.equal(saved.approved_content, 'Persistent approval fixture');
  } finally { await disk.close(); rmSync(dir, { recursive: true, force: true }); }
});
