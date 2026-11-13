import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gemini } from '../src/ai.js';

function body(file, name, mode, input = {}) {
  const w = JSON.parse(readFileSync(new URL('../workflows/' + file, import.meta.url)));
  const expression = w.nodes.find(n => n.name === name).parameters.jsonBody;
  return new Function('$execution', '$json', 'return (' + expression.slice(3, -2) + ')')({ mode, id: '123' }, input);
}
test('n8n test mode creates manual batches; production and inherited modes stay distinct', () => {
  const a = body('01-topic-discovery.json', 'Discover and research', 'test');
  assert.equal(a.mode, 'manual');
  assert.equal(body('01-topic-discovery.json', 'Discover and research', 'production').mode, 'scheduled');
  assert.equal(body('02-tweet-generation.json', 'Generate validated batch', 'test').mode, 'manual');
  assert.deepEqual(body('02-tweet-generation.json', 'Generate validated batch', 'production', a), a);
});
test('local Gemini pacing failure is explicit and never calls the API', async () => {
  await assert.rejects(gemini({ freeTierConfirmed: true, geminiKey: 'test', geminiModel: 'test' },
    { command: async () => { throw new Error('Gemini local pacing limit'); } }, '', 5,
    () => assert.fail('API must not be called')), { code: 'gemini_local_pacing_limit' });
});
