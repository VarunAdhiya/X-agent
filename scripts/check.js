import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const files = readdirSync(new URL('../workflows/', import.meta.url)).filter(x => x.endsWith('.json'));
assert.equal(files.length, 5);
const workflows = files.map(f => JSON.parse(readFileSync(new URL(`../workflows/${f}`, import.meta.url))));
for (const w of workflows) {
  assert.equal(w.active, false);
  assert.equal(w.settings.timezone, 'Asia/Kolkata');
  const names = new Set(w.nodes.map(n => n.name));
  assert.equal(names.size, w.nodes.length);
  for (const [from, connections] of Object.entries(w.connections)) {
    assert(names.has(from));
    for (const outputs of connections.main) for (const target of outputs) assert(names.has(target.node));
  }
  for (const node of w.nodes) {
    for (const credential of Object.values(node.credentials || {})) assert(!credential.id, 'Do not fabricate credential IDs');
    assert(!node.retryOnFail, 'No automatic workflow retry of side effects');
  }
  if (w.settings.errorWorkflow) assert(workflows.some(x => x.id === w.settings.errorWorkflow));
}
console.log('Workflow JSON, references, inactive defaults, credentials, and connections validated. This is not an n8n import test.');
