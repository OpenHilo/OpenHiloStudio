const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalDeployment } = require('@openhilo/server/local-deployment');
const { createWorkerLaunch } = require('@openhilo/server/worker-launch');
const { initializeDemo } = require('../../apps/server/examples/offline-demo/host.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(read) {
  for (let i = 0; i < 500; i++) { const value = await read(); if (value) return value; await delay(10); }
  throw Error('Compatibility fixture did not settle');
}
const code = (id, script, next) => ({ id, type: 'call', executor: 'code', lang: 'bash', script, inputsFrom: {}, outputsTo: {}, outputs: {}, next });
async function setup(t, mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-core-compat-'));
  initializeDemo(home);
  const workdir = path.join(home, 'work'); fs.mkdirSync(workdir); fs.writeFileSync(path.join(workdir, 'mode'), mode);
  const host = await createLocalDeployment({ home,
    aiExecutor: { id: 'unused-generation', capabilities: [], start() { throw Error('No generation expected'); } },
    launch: createWorkerLaunch({ compositionModule: path.join(__dirname, 'fixtures/core-compatibility-worker.cjs'), env: { STUDIO_COMPAT_HOME: home } }),
    clock: { validate: () => true, schedule() { throw Error('No schedules expected'); } },
  });
  t.after(async () => { fs.writeFileSync(path.join(workdir, 'release'), 'yes'); await host.app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const hasHuman = ['ai', 'code', 'stop-human'].includes(mode);
  const nodes = {
    before: code('before', 'printf "before\\n" >> effects', hasHuman ? 'human' : mode === 'stop-code' ? 'hold' : 'ai'),
    human: { id: 'human', type: 'call', executor: 'human', intent: 'Approve once', inputsFrom: {}, outputsTo: { approved: 'approved' }, outputs: { approved: 'boolean' }, next: 'ai' },
    fallback: code('fallback', 'printf \"fallback\\n\" >> effects', 'after'),
    ai: { ...(mode === 'provider-cancel' || mode === 'stop-ai' ? { on_failure: 'fallback' } : {}), id: 'ai', type: 'call', executor: 'ai', intent: 'Compatibility check', inputsFrom: {}, outputsTo: {}, outputs: {}, next: mode === 'code' ? 'repair' : 'after' },
    repair: { ...code('repair', 'import os\nif not os.path.exists("repaired"): raise ValueError("repair needed")\nwith open("effects", "a") as output: output.write("repair\\n")\nvalue = 1', 'after'), lang: 'python', outputs: { value: 'number' }, outputsTo: { value: 'value' } },
    hold: code('hold', 'touch code-ready; while [ ! -f release ]; do sleep 0.05; done; printf "drained\\n" >> effects', 'after'),
    after: code('after', 'printf "after\\n" >> effects', 'END'),
  };
  if (mode === 'shape') {
    nodes.ai.outputs = {plan:'json'};
    nodes.ai.outputShapes = {plan:{type:'object',properties:{urls:{shape:{type:'array',items:{type:'text'}}}}}};
  }
  fs.writeFileSync(path.join(home, 'intents/fixture.itt.impl.json'), JSON.stringify({ version: 2, entry: 'before', nodes }));
  const request = async (method, url, payload, status = 200) => {
    const response = await host.app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, status, response.body); return response.json();
  };
  const { runId } = await request('POST', '/api/runs', { ittPath: 'fixture.itt.impl.json', workdir, inputs: {} }, 201);
  const url = '/api/runs/' + runId;
  const read = () => request('GET', url);
  const idle = () => wait(async () => !host.workers.isActive(runId) && await read());
  const answerHuman = async () => {
    const human = await request('GET', url + '/human-node');
    await request('POST', url + '/resume', { humanNodeRunId: human.nodeRunId, humanOutput: { approved: 'true' } });
  };
  return { host, home, workdir, runId, url, request, read, idle, answerHuman };
}

for (const mode of ['ai', 'code']) test(`upgraded core: Studio ${mode} failure retry preserves completed effects and Human answers`, { timeout: 20000 }, async t => {
  const f = await setup(t, mode);
  assert.equal((await f.idle()).status, 'suspended');
  await f.answerHuman(); const failed = await f.idle(); assert.equal(failed.status, 'failed');
  const failure = failed.events.findLast(event => event.event === 'run_failed'); assert.ok(failure?.node_run_id);
  const rejected = await f.host.app.inject({ method: 'POST', url: f.url + '/resume', payload: { retryFailedNode: 'stale' } });
  assert.ok(rejected.statusCode >= 400); assert.equal(f.host.workers.isActive(f.runId), false);
  fs.writeFileSync(path.join(f.workdir, 'repaired'), 'yes');
  await f.request('POST', f.url + '/resume', { retryFailedNode: failure.node_run_id });
  const done = await f.idle(); assert.equal(done.status, 'completed', JSON.stringify(done.events.slice(-5)));
  assert.equal(fs.readFileSync(path.join(f.workdir, 'effects'), 'utf8'), mode === 'code' ? 'before\nrepair\nafter\n' : 'before\nafter\n');
  assert.equal(fs.readFileSync(path.join(f.workdir, 'ai-calls'), 'utf8'), mode === 'ai' ? 'call\ncall\n' : 'call\n');
  assert.equal(fs.readFileSync(path.join(f.workdir, 'ai-effects'), 'utf8'), 'done\n');
  const history = await f.request('GET', f.url + '/human-history');
  assert.equal(history.length, 1); assert.equal(history[0].status, 'completed'); assert.deepEqual(history[0].result, { approved: true });
  assert.equal(done.events.filter(event => event.event === 'node_pending' && event.node_id === 'before').length, 1);
});

test('upgraded core: live progress reaches Studio before answering and question waits do not spend the configured AI budget', { timeout: 15000 }, async t => {
  const f = await setup(t, 'question');
  const question = await wait(async () => (await f.request('GET', f.url + '/ai-questions')).find(q => q.available));
  const live = await f.read();
  assert.equal(live.status, 'running');
  assert.ok(live.events.some(e => e.event === 'ai_progress' && e.message.includes('before completion')));
  const aiId = live.events.find(e => e.event === 'node_pending' && e.node_id === 'ai').node_run_id;
  assert.ok(!live.events.some(e => e.event === 'node_success' && e.node_run_id === aiId));
  const address = await f.host.app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(address + f.url + '/events', { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  await delay(850); // Longer than the whole 600ms active-time allowance.
  const waiting = await f.read();
  const health = waiting.events.findLast(e => e.event === 'ai_health')?.health;
  assert.equal(health.phase, 'waiting_for_input'); assert.ok(health.remainingMs > 200); assert.equal(health.deadlineAt, undefined);
  const key = { taskId: question.taskId, attemptId: question.attemptId, questionId: question.questionId };
  await f.request('POST', f.url + '/ai-questions/answer', { key, value: 'yes' });
  let stream = '';
  while (!stream.includes('compatibility live stream after answer')) {
    const chunk = await reader.read(); assert.equal(chunk.done, false);
    stream += new TextDecoder().decode(chunk.value);
  }
  assert.equal((await f.read()).status, 'running', 'SSE output must arrive before completion');
  const confirm = await wait(async () => (await f.request('GET', f.url + '/ai-questions')).find(q => q.available && q.questionId === 'confirm'));
  await f.request('POST', f.url + '/ai-questions/answer', {
    key: { taskId: confirm.taskId, attemptId: confirm.attemptId, questionId: confirm.questionId }, value: 'finish',
  });
  await reader.cancel();
  assert.equal((await f.idle()).status, 'completed');
  assert.equal(fs.readFileSync(path.join(f.workdir, 'effects'), 'utf8'), 'before\nafter\n');
});

test('upgraded core: configured active-time timeout cleans up and fails without automatic retry', { timeout: 15000 }, async t => {
  const f = await setup(t, 'timeout'); const result = await f.idle();
  assert.equal(result.status, 'failed');
  assert.equal(result.events.findLast(e => e.event === 'run_failed').failure.code, 'timeout');
  assert.equal(fs.readFileSync(path.join(f.workdir, 'ai-cleanup'), 'utf8'), 'closed');
  assert.equal(fs.readFileSync(path.join(f.workdir, 'ai-calls'), 'utf8'), 'call\n');
  assert.equal(fs.readFileSync(path.join(f.workdir, 'effects'), 'utf8'), 'before\n');
});

test('upgraded core: default 12-hour AI allowance remains manually stoppable while waiting for an answer', { timeout: 15000 }, async t => {
  const f = await setup(t, 'stop-ai');
  const question = await wait(async () => (await f.request('GET', f.url + '/ai-questions')).find(q => q.available));
  const live = await f.read(); const health = live.events.findLast(e => e.event === 'ai_health').health;
  assert.ok(health.remainingMs > 11 * 60 * 60 * 1000 && health.remainingMs <= 12 * 60 * 60 * 1000);
  await f.request('POST', f.url + '/abort', {}); assert.equal((await f.idle()).status, 'aborted');
  const late = await f.host.app.inject({ method: 'POST', url: f.url + '/ai-questions/answer', payload: {
    key: { taskId: question.taskId, attemptId: question.attemptId, questionId: question.questionId }, value: 'late',
  } });
  assert.ok(late.statusCode >= 400);
  assert.equal(fs.readFileSync(path.join(f.workdir, 'effects'), 'utf8'), 'before\n');
  assert.equal(fs.existsSync(path.join(f.workdir, 'ai-effects')), false);
  assert.equal(fs.readFileSync(path.join(f.workdir, 'ai-cleanup'), 'utf8'), 'closed');
});

test('upgraded core: stopping a suspended Human run prevents later resume', { timeout: 15000 }, async t => {
  const f = await setup(t, 'stop-human'); assert.equal((await f.idle()).status, 'suspended');
  await f.request('POST', f.url + '/abort', {}); assert.equal((await f.read()).status, 'aborted');
  await f.request('POST', f.url + '/resume', { humanOutput: { approved: 'true' } }, 409);
  assert.equal(fs.readFileSync(path.join(f.workdir, 'effects'), 'utf8'), 'before\n');
});

test('upgraded core: stopping during Code drains its owned effect and admits no following node', { timeout: 15000 }, async t => {
  const f = await setup(t, 'stop-code'); await wait(() => fs.existsSync(path.join(f.workdir, 'code-ready')));
  await f.request('POST', f.url + '/abort', {}); await delay(50);
  assert.equal(f.host.workers.isActive(f.runId), true);
  assert.notEqual((await f.read()).status, 'aborted');
  fs.writeFileSync(path.join(f.workdir, 'release'), 'yes');
  assert.equal((await f.idle()).status, 'aborted');
  assert.equal(fs.readFileSync(path.join(f.workdir, 'effects'), 'utf8'), 'before\ndrained\n');
});

// A provider-confirmed cancellation can happen without a Studio /abort request.
// The core must report aborted, not create a retryable failure or run on_failure.
test('confirmed AI cancellation bypasses fallback and rejects explicit resume through Studio', { timeout: 15000 }, async t => {
  const f = await setup(t, 'provider-cancel');
  const result = await f.idle();
  assert.equal(result.status, 'aborted');
  assert.equal(result.events.at(-1).event, 'run_abort');
  assert.equal(result.events.some(e => ['run_failed', 'suspended_state', 'run_complete'].includes(e.event)), false);
  assert.equal(fs.readFileSync(path.join(f.workdir, 'effects'), 'utf8'), 'before\n');
  assert.equal(fs.readFileSync(path.join(f.workdir, 'ai-cleanup'), 'utf8'), 'closed');
  const rejected = await f.host.app.inject({ method:'POST', url:f.url+'/resume', payload:{retryFailedNode:result.events.findLast(e=>e.event==='node_failed').node_run_id} });
  assert.ok(rejected.statusCode >= 400);
  assert.equal(f.host.workers.isActive(f.runId), false);
  assert.equal(fs.readFileSync(path.join(f.workdir, 'effects'), 'utf8'), 'before\n');
});


test('Studio exposes nested output validation failure before downstream Code and does not automatically retry', async t => {
  const f=await setup(t,'shape'); const result=await f.idle();
  assert.equal(result.status,'failed');
  const failed=result.events.findLast(e=>e.event==='run_failed');
  assert.equal(failed.failure.code,'invalid_output'); assert.match(failed.failure.message,/plan.urls: required/);
  assert.equal(fs.readFileSync(path.join(f.workdir,'effects'),'utf8'),'before\n');
  assert.equal(fs.readFileSync(path.join(f.workdir,'ai-calls'),'utf8'),'call\n');
  assert.equal(f.host.workers.isActive(f.runId),false);
});
