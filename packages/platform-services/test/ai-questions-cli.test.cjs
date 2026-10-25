const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAiQuestionsCli } = require('@openhilo/platform-services/ai-questions-cli');

test('question CLI sends typed answers to the explicit server and does not retry lost responses', async () => {
  const output = [], errors = [], calls = [];
  const io = { out: text => output.push(text), error: text => errors.push(text), fetch: async (url, options) => {
    calls.push([String(url), options]); return new Response(JSON.stringify({ receipt: 'accepted' }));
  } };
  const args = ['answer', 'run/with space', '--server', 'http://127.0.0.1:39317', '--task', 't', '--attempt', 'a', '--question', 'q'];
  assert.equal(await runAiQuestionsCli([...args, '--json', '{"enabled":true}'], io), 0);
  assert.equal(calls[0][0], 'http://127.0.0.1:39317/api/runs/run%2Fwith%20space/ai-questions/answer');
  assert.deepEqual(JSON.parse(calls[0][1].body), { key: { taskId: 't', attemptId: 'a', questionId: 'q' }, value: { enabled: true } });
  assert.equal(await runAiQuestionsCli([...args, '--json', 'invalid'], io), 1); assert.equal(calls.length, 1);
  assert.equal(await runAiQuestionsCli([...args, '--json', '1e999'], io), 1); assert.equal(calls.length, 1);
  let failed = 0;
  assert.equal(await runAiQuestionsCli([...args, '--text', 'yes'], { ...io, fetch: async () => { failed++; throw new Error('Lost connection'); } }), 1);
  assert.equal(failed, 1); assert.match(errors.at(-1), /No automatic retry/);
  assert.equal(await runAiQuestionsCli(['list', 'run', '--server', 'http://127.0.0.1:39317'], io), 0);
  assert.equal(calls[1][1].method, 'GET'); assert.equal(calls[1][1].body, undefined);
});
