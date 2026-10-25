const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const Fastify = require('fastify');
const { WorkerSupervisor } = require('@openhilo/platform-services/worker-supervisor');
const { registerHumanRoutes } = require('@openhilo/server/routes/human');
const { registerRunRoutes } = require('@openhilo/server/routes/runs');

function fixture(t, outputs = { count: 'number' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'human-submission-api-'));
  const runDir = path.join(home, 'fixture');
  fs.mkdirSync(path.join(runDir, '.snapshot'), { recursive: true });
  const record = { run_id: 'fixture', intent: 'flow', workdir: home, status: 'suspended', created_at: '2026-01-01', updated_at: '2026-01-01' };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(record));
  fs.writeFileSync(path.join(runDir, '.snapshot', 'flow.itt.impl.json'), JSON.stringify({ nodes: { review: {
    type: 'call', executor: 'human', intent: 'Review', outputsTo: Object.fromEntries(Object.keys(outputs).map(key => [key, key])), outputs,
  } } }));
  const taskId = randomUUID();
  const task = { version: 1, taskId, runId: 'fixture', nodeId: 'review', nodeRunId: 'pending', prompt: 'Review', inputs: {}, outputs, createdAt: new Date().toISOString() };
  fs.mkdirSync(path.join(runDir, 'human-tasks', taskId), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'human-tasks', taskId, 'request.json'), JSON.stringify(task));
  fs.writeFileSync(path.join(runDir, 'execution.jsonl'), [
    { event: 'node_pending', ts: 1, node_id: 'review', node_run_id: 'pending', executor: 'human' },
    { event: 'node_suspended', ts: 2, node_run_id: 'pending', task_id: taskId },
    { event: 'suspended_state', ts: 3, call_stack: [{ frame_id: 'f', intent_name: 'flow', current_node: 'review', scope_stack: [] }] },
  ].map(JSON.stringify).join('\n') + '\n');
  const children = [];
  const options = { launch: () => ({ file: '/unused.cjs', options: {} }),
    fork() { const child = Object.assign(new EventEmitter(), { pid: 123, send(_value, cb) { cb?.(null); } }); children.push(child); return child; },
    handleSystemCall: async () => {}, broadcaster: { publish() {}, closeAll() {} } };
  const manager = new WorkerSupervisor(options);
  const app = Fastify(); const paths = { runsDir: home };
  registerHumanRoutes(app, manager, paths); registerRunRoutes(app, manager, paths);
  const submit = (humanSubmission, endpoint = 'human-node') => app.inject({ method: 'POST', url: `/api/runs/fixture/${endpoint}`, payload: { humanSubmission } });
  t.after(async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { app, runDir, record, taskId, children, manager, options, submit };
}

test('modern task detail and history expose stable task identity; invalid and stale submissions cannot launch', async t => {
  const f = fixture(t);
  assert.equal((await f.app.inject('/api/runs/fixture/human-node')).json().taskId, f.taskId);
  assert.equal((await f.app.inject('/api/runs/fixture/human-history')).json()[0].taskId, f.taskId);
  for (const endpoint of ['human-node', 'resume']) {
    const invalid = await f.submit({ taskId: f.taskId, submissionId: randomUUID(), outputs: { count: '12x' } }, endpoint);
    assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().status, 'invalid');
    const stale = await f.submit({ taskId: randomUUID(), submissionId: randomUUID(), outputs: { count: '12' } }, endpoint);
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().status, 'stale');
  }
  assert.equal(f.children.length, 0);
  assert.equal(fs.existsSync(path.join(f.runDir, 'human-tasks', f.taskId, 'submission.json')), false);
});

test('accepted confirmation is durable before launch and duplicates never launch an active or completed task', async t => {
  const f = fixture(t);
  const submission = { taskId: f.taskId, submissionId: randomUUID(), outputs: { count: '12' } };
  const originalFork = f.options.fork;
  f.options.fork = () => { assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.runDir, 'human-tasks', f.taskId, 'submission.json'))), submission); return originalFork(); };
  const accepted = await f.submit(submission);
  assert.equal(accepted.statusCode, 200); assert.equal(accepted.json().status, 'accepted');
  const history = (await f.app.inject('/api/runs/fixture/human-history')).json()[0];
  assert.equal(history.status, 'suspended', 'accepted is not workflow completion');
  assert.deepEqual(history.acceptedSubmission, submission);
  for (const endpoint of ['human-node', 'resume']) {
    assert.equal((await f.submit(submission, endpoint)).json().status, 'duplicate');
    const conflict = await f.submit({ ...submission, submissionId: randomUUID() }, endpoint);
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().status, 'conflict');
  }
  assert.equal(f.children.length, 1);
  fs.writeFileSync(path.join(f.runDir, 'run.json'), JSON.stringify({ ...f.record, status: 'completed' }));
  f.children[0].emit('message', { type: 'done', runId: 'fixture', status: 'completed' }); f.children[0].emit('exit', 0);
  assert.equal((await f.submit(submission, 'resume')).json().status, 'duplicate'); assert.equal(f.children.length, 1);
});

test('removed decision payloads cannot write a result or launch a worker', async t => {
  const f = fixture(t);
  for (const endpoint of ['human-node', 'resume']) for (const decision of ['confirm', 'reject']) {
    const response = await f.submit({taskId:f.taskId,submissionId:randomUUID(),decision,outputs:{count:'12'}},endpoint);
    assert.equal(response.statusCode,400,response.body);
  }
  assert.equal(f.children.length,0);
  assert.equal(fs.existsSync(path.join(f.runDir,'human-tasks',f.taskId,'submission.json')),false);
});

test('zero-output tasks require an explicit decision and a committed decision survives launch failure', async t => {
  const f = fixture(t, {});
  assert.equal(f.children.length, 0);
  const submission = { taskId: f.taskId, submissionId: randomUUID(), outputs: {} };
  const originalLaunch = f.options.launch; f.options.launch = () => { throw new Error('Launch unavailable'); };
  assert.equal((await f.submit(submission)).statusCode, 500);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runDir, 'run.json'))).status, 'suspended');
  assert.deepEqual((await f.app.inject('/api/runs/fixture/human-node')).json().acceptedSubmission, submission);
  f.options.launch = originalLaunch;
  const retried = await f.submit(submission);
  assert.equal(retried.statusCode, 200); assert.equal(retried.json().status, 'duplicate'); assert.equal(f.children.length, 1);
});

test('accepted business result can be recovered through task detail after launch failure', async t => {
  const f = fixture(t);
  const submission = { taskId: f.taskId, submissionId: randomUUID(), outputs: { count: '12' } };
  const originalFork = f.options.fork; f.options.fork = () => { throw new Error('Worker unavailable'); };
  assert.equal((await f.submit(submission)).statusCode, 500);
  const pending = await f.app.inject('/api/runs/fixture/human-node');
  assert.equal(pending.statusCode, 200); assert.deepEqual(pending.json().acceptedSubmission, submission);
  assert.deepEqual((await f.app.inject('/api/runs/fixture/human-history')).json()[0].acceptedSubmission, submission);
  f.options.fork = originalFork;
  const retried = await f.submit(pending.json().acceptedSubmission);
  assert.equal(retried.statusCode, 200); assert.equal(retried.json().status, 'duplicate'); assert.equal(f.children.length, 1);
});

test('mixed legacy and modern answers fail before accepting a decision or launching a worker', async t => {
  const f = fixture(t);
  const humanSubmission = { taskId: f.taskId, submissionId: randomUUID(), outputs: { count: '12' } };
  for (const endpoint of ['human-node', 'resume']) {
    const response = await f.app.inject({ method: 'POST', url: `/api/runs/fixture/${endpoint}`, payload: { humanSubmission, humanOutput: { count: '12' } } });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(f.children.length, 0);
  assert.equal(fs.existsSync(path.join(f.runDir, 'human-tasks', f.taskId, 'submission.json')), false);
});

test('deployment resume preflight rejects before persisting an answer or launching work',async t=>{
 const f=fixture(t);let checked=0;
 f.options.beforeResume=opts=>{checked++;assert.equal(opts.runDir,f.runDir);throw Object.assign(new Error('AI routing configuration changed; restore the original configuration'),{statusCode:400})};
 for(const endpoint of ['human-node','resume']){
  const result=await f.submit({taskId:f.taskId,submissionId:randomUUID(),outputs:{count:'12'}},endpoint);assert.equal(result.statusCode,400,result.body);assert.match(result.json().message,/AI routing/);
 }
 assert.equal(checked,2);assert.equal(f.children.length,0);assert.equal(fs.existsSync(path.join(f.runDir,'human-tasks',f.taskId,'submission.json')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(f.runDir,'run.json'))).status,'suspended');
});
