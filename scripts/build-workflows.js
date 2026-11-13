import { mkdirSync, writeFileSync } from 'node:fs';

const directory = new URL('../workflows/', import.meta.url);
mkdirSync(directory, { recursive: true });
const node = (name, type, parameters, position, typeVersion = 1, extra = {}) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type: `n8n-nodes-base.${type}`, typeVersion, position, parameters, ...extra
});
const manual = () => node('Manual rerun', 'manualTrigger', {}, [0, 220]);
const timer = (cron) => node('Schedule IST', 'scheduleTrigger', { rule: { interval: [{ field: 'cronExpression', expression: cron }] } }, [0, 0], 1.2);
const http = (name, path, position, body = '={{ {} }}', extra = {}) => node(name, 'httpRequest', {
  method: 'POST', url: `http://agent:3000/${path}`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendBody: true, specifyBody: 'json', jsonBody: body,
  options: { timeout: 300000 }
}, position, 4.2, { credentials: { httpHeaderAuth: { name: 'Agent internal API — configure after import' } }, ...extra });
const connection = (...names) => ({ main: [names.map(name => ({ node: name, type: 'main', index: 0 }))] });
function save(file, id, name, nodes, connections, isError = false) {
  const data = { id, name, active: false, nodes, connections, settings: { executionOrder: 'v1', timezone: 'Asia/Kolkata',
    saveDataErrorExecution: 'none', saveDataSuccessExecution: 'none', saveManualExecutions: false,
    executionTimeout: 900, ...(isError ? {} : { errorWorkflow: 'XAgentMonitoring' }) }, pinData: {}, tags: [] };
  writeFileSync(new URL(file, directory), JSON.stringify(data, null, 2) + '\n');
}
const note = text => node('Setup notes', 'stickyNote', { content: text, height: 250, width: 440 }, [0, -320]);
save('01-topic-discovery.json', 'XAgentDiscovery', 'X Agent · A · Daily topic discovery', [
  timer('0 7 * * *'), manual(), http('Discover and research', 'discover', [260, 0], '={{ { mode: $execution.mode === "test" ? "manual" : "scheduled", request_id: "discovery:" + $execution.id } }}'),
  node('Run generation workflow', 'executeWorkflow', { source: 'database', workflowId: { __rl: true, value: 'XAgentGeneration', mode: 'id' },
    mode: 'once', options: { waitForSubWorkflow: true } }, [520, 0], 1.2),
  note('Runs at 07:00 Asia/Kolkata. Configure Agent internal API header credential on the HTTP node. Select Workflow B in Execute Workflow after import if n8n remaps IDs. Discovery normalizes and researches sources; database prevents reuse and duplicate daily batches.')
], { 'Schedule IST': connection('Discover and research'), 'Manual rerun': connection('Discover and research'),
  'Discover and research': connection('Run generation workflow') });
save('02-tweet-generation.json', 'XAgentGeneration', 'X Agent · B · Generate five drafts', [
  node('Called by discovery', 'executeWorkflowTrigger', { inputSource: 'passthrough' }, [0, 0], 1.1), manual(),
  http('Generate validated batch', 'generate', [260, 0], '={{ { mode: $json.mode || ($execution.mode === "test" ? "manual" : "scheduled"), request_id: $json.request_id || ("generation:" + $execution.id) } }}'), http('Deliver draft messages', 'monitor', [520, 0]),
  note('Scheduled: one five-draft batch per IST day. Each new manual execution requests five additional unscheduled drafts, subject to Gemini budget and available unique topics. Gemini JSON is validated by the internal service and saved through restricted PostgreSQL functions. Retries of the same execution ID do not duplicate its batch. Failed runs can be rerun after fixing their cause.')
], { 'Called by discovery': connection('Generate validated batch'), 'Manual rerun': connection('Generate validated batch'),
  'Generate validated batch': connection('Deliver draft messages') });
save('03-telegram-approval.json', 'XAgentApproval', 'X Agent · C · Telegram approval', [
  node('Telegram webhook', 'webhook', { httpMethod: 'POST', path: 'telegram-approval', authentication: 'headerAuth',
    responseMode: 'responseNode', options: {} }, [0, 0], 2, {
      webhookId: 'x-agent-telegram-approval', credentials: { httpHeaderAuth: { name: 'Telegram webhook secret — configure after import' } }
    }),
  http('Persist authorized update', 'telegram', [260, 0], '={{ { update: $json.body, secret: $json.headers["x-telegram-bot-api-secret-token"] } }}'),
  node('Acknowledge durable receipt', 'respondToWebhook', { respondWith: 'json', responseBody: '{"ok":true}', options: { responseCode: 200 } }, [520, 0], 1.4),
  http('Process approval inbox', 'approval', [780, 0]),
  note('Set webhook header credential: X-Telegram-Bot-Api-Secret-Token = TELEGRAM_WEBHOOK_SECRET. Set HTTP nodes to the separate Agent internal API credential. Acknowledge only AFTER durable inbox insertion. /monitor also recovers pending inbox work. Only the configured private chat and allowlisted sender are accepted.')
], { 'Telegram webhook': connection('Persist authorized update'), 'Persist authorized update': connection('Acknowledge durable receipt'),
  'Acknowledge durable receipt': connection('Process approval inbox') });
save('04-scheduled-publishing.json', 'XAgentPublishing', 'X Agent · D · Scheduled publishing', [
  timer('* * * * *'), manual(), http('Claim and publish safely', 'publish', [260, 0]),
  note('Poll every minute; database permits only 10:00 / 13:00 / 16:00 / 19:00 / 22:00 IST slots within a five-minute grace window. Approval must predate the slot. DRY_RUN=true is default. Never enable HTTP node retry: ambiguous X responses require manual reconciliation.')
], { 'Schedule IST': connection('Claim and publish safely'), 'Manual rerun': connection('Claim and publish safely') });
save('05-error-monitoring.json', 'XAgentMonitoring', 'X Agent · E · Errors and monitoring', [
  node('Workflow error', 'errorTrigger', {}, [0, 0]),
  http('Record sanitized failure', 'error', [260, 0], '={{ $json }}', { onError: 'continueErrorOutput' }),
  node('Throttle outage alerts', 'code', { jsCode: "const state = $getWorkflowStaticData('global');\nconst now = Date.now();\nif (now - (state.lastEmergencyAlert || 0) < 3600000) return [];\nstate.lastEmergencyAlert = now;\nreturn [{ json: { alert: true } }];" }, [500, 100], 2),
  node('Emergency Telegram alert', 'telegram', { resource: 'message', operation: 'sendMessage', chatId: 'REPLACE_WITH_PRIVATE_CHAT_ID',
    text: 'X content agent cannot record an n8n error. Check the VPS, internal service and Supabase. Publishing remains approval-gated.', additionalFields: { appendAttribution: false } }, [760, 100], 1.2,
    { credentials: { telegramApi: { name: 'Telegram bot — configure after import' } } }),
  timer('* * * * *'), http('Recover and deliver outbox', 'monitor', [260, 300], '={{ {} }}', { onError: 'continueErrorOutput' }),
  manual(), note('Select this workflow as Error Workflow in A–D after import. Configure emergency Telegram credential + private chat ID. Its fallback can notify when the internal service/database is unavailable. This workflow does not self-reference as an error workflow. Monitor detects stuck claims and never retries X posting. External VM outages cannot be detected by the same VM.')
], { 'Workflow error': connection('Record sanitized failure'),
  'Record sanitized failure': { main: [[], [{ node: 'Throttle outage alerts', type: 'main', index: 0 }]] },
  'Throttle outage alerts': connection('Emergency Telegram alert'),
  'Schedule IST': connection('Recover and deliver outbox'), 'Manual rerun': connection('Recover and deliver outbox'),
  'Recover and deliver outbox': { main: [[], [{ node: 'Throttle outage alerts', type: 'main', index: 0 }]] }
}, true);
console.log('Wrote five inactive workflows; credentials require configuration.');
