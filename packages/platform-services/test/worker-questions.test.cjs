const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWorkerQuestionClient } = require('@openhilo/platform-services/worker-questions');
const key = { taskId: 't', attemptId: 'a', questionId: 'q' };

test('lost IPC receipts do not resend an answer; disconnection rejects in-flight delivery', async () => {
  let calls = 0;
  const worker = Object.assign(new EventEmitter(), { connected: true, send(_message, callback) { calls++; callback(); } });
  const client = createWorkerQuestionClient(worker, 15);
  await assert.rejects(client.answer(key, 'once'), /outcome is unknown/);
  assert.equal(calls, 1);
  const pending = client.answer(key, 'manual'); worker.emit('disconnect');
  await assert.rejects(pending, /outcome is unknown/);
  assert.equal(await client.answer(key, 'later'), 'unavailable');
  assert.equal(calls, 2); assert.equal(worker.listenerCount('message'), 0);
});

test('IPC correlation ignores late/foreign receipts and removes timers after success', async () => {
  let request;
  const worker = Object.assign(new EventEmitter(), { connected: true, send(message, callback) { request = message; callback(); } });
  const client = createWorkerQuestionClient(worker, 1000), pending = client.answer(key, { approved: true });
  worker.emit('message', { type: 'ai_answer_result', reqId: 'foreign', receipt: 'closed' });
  worker.emit('message', { type: 'ai_answer_result', reqId: request.reqId, receipt: 'accepted' });
  assert.equal(await pending, 'accepted'); client.close();
});
