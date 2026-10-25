const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StudioHumanExecutor } = require('../dist');
const request = { version: 1, taskId: 'task-1', runId: 'run-1', nodeId: 'review', nodeRunId: 'nr-1', prompt: 'Review', inputs: {}, outputs: {}, createdAt: '2026-10-03T00:00:00Z' };
const host = { signal: new AbortController().signal, submit() { throw new Error('Adapter must not submit outputs'); } };
test('Studio publishes the task then returns without submitting human outputs', async () => {
  const published = [];
  await new StudioHumanExecutor({ notify: async task => { await Promise.resolve(); published.push(task); } }).present(request, host);
  assert.deepEqual(published, [request]);
  await new StudioHumanExecutor().present(request, host);
});
test('notification failures propagate and an aborted presentation does not publish', async () => {
  await assert.rejects(new StudioHumanExecutor({ notify: () => { throw new Error('Unavailable'); } }).present(request, host), /Unavailable/);
  const controller = new AbortController(); controller.abort();
  const published = [];
  await new StudioHumanExecutor({ notify: task => published.push(task) }).present(request, { ...host, signal: controller.signal });
  assert.deepEqual(published, []);
});
