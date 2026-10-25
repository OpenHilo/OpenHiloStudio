const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTaskExecution } = require('@openhilo/ai-contracts');
const { suggestSkills } = require('@openhilo/platform-services/skill-suggestions');
const input = { fnName: 'review_by_ai', role: 'reviewer', intent: 'Review', currentSkills: [] };
const catalogue = ['a:one', 'a:two', 'a:three', 'a:four'];
const session = { executorId: 'offline', version: 1, opaqueId: 'fixture' };
const fake = output => ({ id: 'offline', capabilities: ['structured_output'],
  async start(request, host) { return createTaskExecution(request, host, async () => ({ status: 'completed', outputs: { skills: output }, artifacts: [], session })); } });

test('suggestions use only the provided catalogue, deduplicate and cap results, then release sessions', async () => {
  const executor = fake(['a:one', 'unknown', 'a:one', 'a:two', 'a:three', 'a:four']);
  const start = executor.start; let released = 0;
  executor.start = (request, host) => {
    assert.deepEqual(request.inputs.catalogue, catalogue);
    assert.equal(host.workspace, undefined); assert.equal(host.tools, undefined);
    assert.ok(Date.parse(host.deadlineAt) > Date.now());
    return start(request, host);
  };
  executor.releaseSession = async ref => { assert.deepEqual(ref, session); released++; };
  assert.deepEqual(await suggestSkills(input, catalogue, executor), catalogue.slice(0, 3));
  assert.equal(released, 1);
});

test('invalid outputs and structured failures release retained state without retry', async () => {
  const executor = fake({ unexpected: true }); let released = 0;
  executor.releaseSession = async () => { released++; };
  await assert.rejects(suggestSkills(input, catalogue, executor), /JSON array/);
  assert.equal(released, 1);
  const failure = { code: 'quota_exhausted', message: 'offline', retryable: true, safeToReplay: false };
  executor.start = async (request, host) => createTaskExecution(request, host, async () => ({ status: 'failed', error: failure, session }));
  await assert.rejects(suggestSkills(input, catalogue, executor), error => error.failure.code === 'quota_exhausted');
  assert.equal(released, 2);
});

test('deadline and unsupported interactive suggestions cancel cooperatively', async () => {
  let aborted = false;
  const slow = { id: 'offline', capabilities: ['structured_output'], async start(request, host) {
    return createTaskExecution(request, host, async context => {
      await new Promise(resolve => context.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return { status: 'completed', outputs: { skills: [] }, artifacts: [] };
    });
  } };
  await assert.rejects(suggestSkills(input, catalogue, slow, { timeoutMs: 15 }), error => error.failure.code === 'timeout');
  assert.equal(aborted, true);
  slow.start = async (request, host) => createTaskExecution(request, host, async context => {
    await context.ask({ id: 'question', prompt: 'Which?', answer: 'text' });
    return { status: 'completed', outputs: { skills: [] }, artifacts: [] };
  });
  await assert.rejects(suggestSkills(input, catalogue, slow), error => error.failure.code === 'unsupported_capability');
});
