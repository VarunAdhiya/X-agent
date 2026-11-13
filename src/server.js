import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { connectDatabase } from './db.js';
import { AgentError, istDay } from './domain.js';
import { discover } from './discovery.js';
import { generate } from './ai.js';
import { ingest, processInbox, deliverOutbox, equalSecret } from './telegram.js';
import { publish } from './publishing.js';

export function createApp(config, db) {
  const running = new Set();
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/health') { res.end('{"ok":true}'); return; }
    if (req.method !== 'POST' || !equalSecret(req.headers['x-agent-token'], config.internalToken)) {
      res.writeHead(401); res.end('{"error":"unauthorized"}'); return;
    }
    let body; let locked = false;
    try {
      let bytes = 0; const parts = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) throw new AgentError('request_too_large', 413);
        parts.push(chunk);
      }
      try { body = JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { throw new AgentError('invalid_json'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AgentError('invalid_body');
      if (running.has(req.url)) { res.end('{"busy":true}'); return; }
      // Telegram ingress cannot be dropped when concurrent updates arrive.
      if (req.url !== '/telegram') { running.add(req.url); locked = true; }
      let result;
      switch (req.url) {
        case '/discover': result = { ...await discover(config, db), mode: body.mode === 'manual' ? 'manual' : 'scheduled', request_id: body.request_id }; break;
        case '/generate': result = await generate(config, db, undefined, body); break;
        case '/telegram': result = await ingest(config, db, body); break;
        case '/approval': result = await processInbox(config, db); break;
        case '/publish': result = await publish(config, db); break;
        case '/monitor': {
          result = await db.command('monitor');
          await processInbox(config, db);
          await deliverOutbox(config, db);
          if (Number(result.database_bytes) > 400 * 1024 * 1024) await db.command('log', { workflow: 'monitor', event: 'storage_warning', status: 'warning',
            message: 'Database approaching the free storage allowance. Review retention.', key: `storage:${istDay()}`, alert: true });
          break;
        }
        case '/error': {
          // Never persist n8n's raw error (it can contain credentials or URLs).
          const workflow = String(body.workflow?.name || 'n8n').replace(/[^\w .-]/g, '').slice(0,80);
          const execution = String(body.execution?.id || 'activation').replace(/[^\w-]/g, '').slice(0,80);
          result = await db.command('log', { workflow, event: 'execution_failed', status: 'error',
            message: `n8n execution ${execution} failed. Inspect the private editor.`, key: `n8n:${workflow}:${execution}:${istDay()}`, alert: true });
          await deliverOutbox(config, db); break;
        }
        default: throw new AgentError('not_found', 404);
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      const code = error instanceof AgentError ? error.code : 'internal_or_database_error';
      // Log only controlled codes, never raw DB errors, credentials, or source bodies.
      console.error(JSON.stringify({ event: 'request_failed', route: req.url, code }));
      const message = code === 'gemini_local_pacing_limit'
        ? 'No new drafts: wait at least 15 seconds between Gemini requests, then retry. The app has no daily request cap. Google free-tier limits still apply.' : code;
      try { await db.command('log', { workflow: String(req.url).slice(0,80), event: code, status: 'error', message,
        key: `http:${req.url}:${code}:${istDay()}`, alert: true }); } catch { /* stderr remains available if DB is down */ }
      res.writeHead(error instanceof AgentError ? error.status : 500);
      res.end(JSON.stringify({ error: code }));
    } finally { if (locked) running.delete(req.url); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const db = connectDatabase(config);
  const app = createApp(config, db);
  app.requestTimeout = 300000;
  app.headersTimeout = 10000;
  app.listen(config.port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'ready', dry_run: config.dryRun })));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    app.close(async () => { await db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 30000).unref();
  });
}
