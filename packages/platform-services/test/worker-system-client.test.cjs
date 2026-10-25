const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWorkerSystemClient } = require('@openhilo/platform-services/worker-system-client');
const { AbortError, FailableError } = require('@openhilo/runtime-contracts');
function channel(send) { return Object.assign(new EventEmitter(), { connected: true, send }); }

test('system responses preserve result/error identity and explicit close removes listeners', async () => {
  let sent;
  const transport = channel((value, done) => { sent = value; done(); });
  const client = createWorkerSystemClient(transport);
  const result = client.call('queryClasses', []);
  transport.emit('message', { type: 'sys_response', reqId: sent.reqId, result: ['Document'] });
  assert.deepEqual(await result, ['Document']);
  const failed = client.call('defineClass', []);
  transport.emit('message', { type: 'sys_response', reqId: sent.reqId, error: 'Already exists' });
  await assert.rejects(failed, FailableError);
  client.close(); assert.equal(transport.listenerCount('message'), 0); assert.equal(transport.listenerCount('disconnect'), 0);
  await assert.rejects(client.call('queryClasses', []), AbortError);
});

for (const kind of ['callback', 'throw', 'disconnect', 'timeout']) test(`system ${kind} failure is surfaced without automatically replaying a possible write`, async () => {
  let calls = 0;
  const transport = channel((_value, done) => { calls++; if (kind === 'throw') throw new Error('lost'); if (kind === 'callback') done(new Error('lost')); });
  const client = createWorkerSystemClient(transport, 10);
  try {
    const result = client.call('createEntity', ['possibly committed']);
    if (kind === 'disconnect') transport.emit('disconnect');
    await assert.rejects(result, error => error instanceof AbortError && /outcome is unknown/.test(error.message));
    assert.equal(calls, 1);
  } finally { client.close(); }
});
