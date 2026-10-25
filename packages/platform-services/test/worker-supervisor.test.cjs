const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { fork } = require('node:child_process');
const { WorkerSupervisor } = require('@openhilo/platform-services/worker-supervisor');
function setup(t, child = Object.assign(new EventEmitter(), { pid: 123, connected: true, disconnect() { this.connected = false; }, send(_msg, cb) { cb?.(null); }, kill() { return true; } })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-supervisor-'));
  fs.writeFileSync(path.join(root, 'run.json'), JSON.stringify({ run_id: 'fixture', status: 'suspended' }));
  fs.mkdirSync(path.join(root, '.snapshot'));
  fs.writeFileSync(path.join(root, '.snapshot', 'workflow.itt.impl.json'), JSON.stringify({ nodes: { review: { type: 'call', executor: 'human', outputsTo: {}, outputs: {} } } }));
  fs.writeFileSync(path.join(root, 'execution.jsonl'), [
    { event: 'node_suspended', ts: 1, node_run_id: 'pending' },
    { event: 'suspended_state', ts: 2, call_stack: [{ frame_id: 'frame', intent_name: 'workflow', current_node: 'review', scope_stack: [] }] },
  ].map(JSON.stringify).join('\n') + '\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const options = { launch: () => ({ file: '/unused-worker.js', options: {} }), fork: () => child,
    handleSystemCall: async () => {}, broadcaster: { publish: (id, message) => events.push([id, JSON.parse(message.slice(6))]), closeAll() {} } };
  return { root, child, events, options, manager: new WorkerSupervisor(options) };
}

test('done messages retain active ownership until process exit', t => {
  const f = setup(t); f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  f.child.emit('message', { type: 'done', runId: 'fixture', status: 'suspended' });
  assert.equal(f.manager.isActive('fixture'), true);
  assert.throws(() => f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} }), /active worker/);
  f.child.emit('exit', 0); assert.equal(f.manager.isActive('fixture'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'))).status, 'suspended');
});

test('IPC errors become visible failures without treating a live process as stopped', t => {
  const f = setup(t); f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  f.child.emit('error', new Error('IPC failed'));
  assert.equal(f.manager.isActive('fixture'), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'))).status, 'failed');
  assert.equal(f.events.at(-1)[1].message, 'IPC failed');
  f.child.emit('exit', 1); assert.equal(f.manager.isActive('fixture'), false);
});

test('abort waits for exit and ignores late completion', t => {
  const f = setup(t); f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  assert.equal(f.manager.abort('fixture', path.join(f.root, 'run.json')), 'ok');
  assert.equal(f.manager.isActive('fixture'), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'))).status, 'suspended');
  assert.ok(f.manager.stopState('fixture').requestedAt);
  f.child.emit('message', { type: 'done', runId: 'fixture', status: 'completed' });
  f.child.emit('error', new Error('Late abort error'));
  assert.equal(f.events.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'))).failReason, undefined);
  f.child.emit('exit', null, 'SIGTERM'); assert.equal(f.manager.isActive('fixture'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'))).status, 'aborted');
  assert.equal(f.manager.abort('missing', path.join(f.root, 'missing.json')), 'not_found');
});

test('failed spawn and pre-start completion cannot leave unresolved startup requests', async t => {
  const child = Object.assign(new EventEmitter(), { send() { throw new Error('Disconnected'); } });
  const f = setup(t, child);
  await assert.rejects(f.manager.forkRun({ ittPath: 'workflow', workdir: f.root, inputs: {} }), /Disconnected/);
  child.send = () => {};
  const pending = f.manager.forkRun({ ittPath: 'workflow', workdir: f.root, inputs: {} });
  child.emit('message', { type: 'done', runId: 'fixture', status: 'completed' });
  await assert.rejects(pending, /before announcing/);
});

test('unexpected exit records failure; terminal and malformed resume requests do not fork', t => {
  const f = setup(t); let forks = 0;
  f.options.fork = () => { forks++; return f.child; };
  assert.throws(() => f.manager.forkResume('fixture', { runDir: f.root, humanOutput: { yes: true } }), /string values/);
  f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  f.child.emit('exit', 9);
  assert.match(JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'))).failReason, /code 9/);
  assert.throws(() => f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} }), /suspended run/);
  assert.equal(forks, 1);
});

for (const mode of ['run', 'resume']) test(`${mode} worker signal exit reports the signal and uncertain effects`, async t => {
  const f = setup(t);
  if (mode === 'run') {
    const started = f.manager.forkRun({ ittPath: 'workflow', workdir: f.root, inputs: {} });
    f.child.emit('message', { type: 'started', runId: 'fixture', runDir: f.root });
    await started;
  } else f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  f.child.emit('exit', null, 'SIGKILL');
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'run.json')));
  assert.equal(saved.status, 'failed');
  assert.match(saved.failReason, /SIGKILL/);
  assert.match(saved.failReason, /unknown outcome.*workdir.*retry/i);
  assert.equal(f.manager.isActive('fixture'), false);
  assert.ok(f.events.some(([, event]) => event.type === 'error' && event.message === saved.failReason));
});

test('real independent children handshake, call the injected system host, suspend, and resume once', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-process-'));
  const entry = path.join(root, 'fixture.cjs'); const children = [], exits = [], completions = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await Promise.all(exits); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(entry, `
    const fs = require('node:fs'), path = require('node:path');
    const { sendWorkerMessage: send } = require(${JSON.stringify(require.resolve('@openhilo/platform-services/worker-protocol'))});
    process.once('message', async opts => {
      const runDir = opts.runDir || path.join(opts.workdir, 'run'); fs.mkdirSync(runDir, { recursive: true });
      if (!opts.runDir) {
        fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run_id: 'fixture', status: 'running' }));
        await send({ type: 'started', runId: 'fixture', runDir });
        const response = new Promise(resolve => process.once('message', resolve));
        await send({ type: 'sys_call', reqId: 'request', method: 'echo', args: ['hello'] });
        fs.writeFileSync(path.join(runDir, 'response.json'), JSON.stringify(await response));
      } else fs.appendFileSync(path.join(runDir, 'human.jsonl'), JSON.stringify(opts.humanOutput) + '\\n');
      const status = opts.runDir ? 'completed' : 'suspended';
      if (status === 'suspended') {
        fs.mkdirSync(path.join(runDir, '.snapshot'));
        fs.writeFileSync(path.join(runDir, '.snapshot', 'workflow.itt.impl.json'), JSON.stringify({ nodes: { review: { type: 'call', executor: 'human', outputsTo: { approved: 'approved' }, outputs: { approved: 'boolean' } } } }));
        fs.writeFileSync(path.join(runDir, 'execution.jsonl'), [
          { event: 'node_suspended', ts: 1, node_run_id: 'pending' },
          { event: 'suspended_state', ts: 2, call_stack: [{ frame_id: 'frame', intent_name: 'workflow', current_node: 'review', scope_stack: [] }] },
        ].map(JSON.stringify).join('\\n') + '\\n');
      }
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run_id: 'fixture', status }));
      process.once('message', () => process.exit(0));
      await send({ type: 'done', runId: 'fixture', status });
    });
  `);
  let notify; const nextDone = () => new Promise(resolve => { notify = resolve; });
  const manager = new WorkerSupervisor({ launch: () => ({ file: entry, options: { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] } }),
    fork(file, args, options) { const child = fork(file, args, options); children.push(child); exits.push(once(child, 'exit')); return child; },
    async handleSystemCall(child, msg) { child.send({ type: 'sys_response', reqId: msg.reqId, result: msg.args[0] }); },
    broadcaster: { publish(_id, text) { const message = JSON.parse(text.slice(6)); if (message.type === 'done') { completions.push(message.status); notify(); } }, closeAll() {} } });
  let done = nextDone();
  assert.equal(await manager.forkRun({ ittPath: 'fixture', workdir: root, inputs: {} }), 'fixture'); await done;
  assert.equal(manager.isActive('fixture'), true);
  const runDir = path.join(root, 'run');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'response.json'))).result, 'hello');
  children[0].send({ exit: true }); await exits[0];
  done = nextDone(); manager.forkResume('fixture', { runDir, humanOutput: { approved: 'true' } });
  assert.throws(() => manager.forkResume('fixture', { runDir, humanOutput: {} }), /active worker/);
  await done; children[1].send({ exit: true }); await exits[1];
  assert.equal(manager.isActive('fixture'), false); assert.deepEqual(completions, ['suspended', 'completed']);
  assert.equal(fs.readFileSync(path.join(runDir, 'human.jsonl'), 'utf8'), '{"approved":"true"}\n');
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test('shutdown drains accepted effects before stopping children and rejects later work', async t => {
  const f = setup(t); let finishEffect, stopped = 0, calls = 0;
  const responses = [];
  f.child.send = (message, cb) => { responses.push(message); cb?.(null); };
  f.options.handleSystemCall = async () => { calls++; await new Promise(resolve => { finishEffect = resolve; }); };
  f.options.stopWorker = child => { assert.equal(child, f.child); stopped++; };
  f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  f.child.emit('message', { type: 'sys_call', reqId: 'accepted', method: 'write', args: [] });
  const closing = f.manager.close();
  assert.equal(closing, f.manager.close());
  await assert.rejects(f.manager.forkRun({ ittPath: 'workflow', workdir: f.root, inputs: {} }), /shutting down/);
  assert.throws(() => f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} }), /shutting down/);
  f.child.emit('message', { type: 'sys_call', reqId: 'late', method: 'write', args: [] });
  await tick();
  assert.equal(stopped, 0); assert.equal(calls, 1);
  assert.match(responses.find(message => message.reqId === 'late').error, /not executed/);
  finishEffect(); await tick(); assert.equal(stopped, 1);
  let closed = false; void closing.then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(f.manager.isActive('fixture'), true);
  f.child.emit('message', { type: 'done', runId: 'fixture', status: 'suspended' });
  f.child.emit('exit', 0); await closing;
  assert.equal(f.manager.isActive('fixture'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'))).status, 'suspended');
});

test('shutdown owns children before their startup handshake and waits for their exit', async t => {
  const f = setup(t); let stopped = 0;
  f.options.stopWorker = () => { stopped++; };
  const starting = f.manager.forkRun({ ittPath: 'workflow', workdir: f.root, inputs: {} });
  const rejected = assert.rejects(starting, /exited unexpectedly/);
  let closed = false; const closing = f.manager.close().then(() => { closed = true; });
  await tick(); assert.equal(stopped, 1); assert.equal(closed, false);
  f.child.emit('exit', 1); await rejected; await closing;
});

test('failed spawn releases shutdown ownership even without an exit event', async t => {
  const child = Object.assign(new EventEmitter(), { send() { throw new Error('Spawn failed'); } });
  const f = setup(t, child);
  await assert.rejects(f.manager.forkRun({ ittPath: 'workflow', workdir: f.root, inputs: {} }), /Spawn failed/);
  await f.manager.close();
});

test('a failed shutdown request reports failure and retains ownership of a live worker', async t => {
  const f = setup(t);
  f.options.stopWorker = () => { throw new Error('Stop denied'); };
  f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  await assert.rejects(f.manager.close(), /shared resources must remain open/);
  assert.equal(f.manager.isActive('fixture'), true);
  f.child.emit('exit', 1);
});

test('shutdown drains host effects even after the originating worker has exited', async t => {
  const f = setup(t); let finish;
  f.options.handleSystemCall = () => new Promise(resolve => { finish = resolve; });
  f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  f.child.emit('message', { type: 'sys_call', reqId: 'pending', method: 'write', args: [] });
  await tick(); f.child.emit('exit', 1);
  let closed = false; const closing = f.manager.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  finish(); await closing;
});

test('default shutdown disconnects a real owned child after delivering its system receipt', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-close-'));
  const entry = path.join(root, 'worker.cjs'); let child, exited;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); if (exited) await exited; fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(entry, `
    const fs = require('node:fs'), path = require('node:path');
    process.once('message', opts => {
      const runDir = opts.workdir;
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run_id: 'fixture', status: 'running' }));
      process.on('message', message => {
        if (message.type === 'sys_response') fs.writeFileSync(path.join(runDir, 'receipt.json'), JSON.stringify(message));
      });
      process.once('disconnect', () => process.exit(fs.existsSync(path.join(runDir, 'receipt.json')) ? 0 : 7));
      process.send({ type: 'started', runId: 'fixture', runDir });
      process.send({ type: 'sys_call', reqId: 'effect', method: 'write', args: [] });
    });
  `);
  let accept, finish;
  const accepted = new Promise(resolve => { accept = resolve; });
  const manager = new WorkerSupervisor({
    launch: () => ({ file: entry, options: { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] } }),
    fork(file, args, options) { child = fork(file, args, options); exited = once(child, 'exit'); return child; },
    async handleSystemCall(worker, message) {
      accept(); await new Promise(resolve => { finish = resolve; });
      await new Promise((resolve, reject) => worker.send({ type: 'sys_response', reqId: message.reqId, result: 'saved' }, error => error ? reject(error) : resolve()));
    },
    broadcaster: { publish() {}, closeAll() {} },
  });
  await manager.forkRun({ ittPath: 'workflow', workdir: root, inputs: {} }); await accepted;
  const closing = manager.close(); finish(); await closing;
  assert.equal((await exited)[0], 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'receipt.json'))).result, 'saved');
  assert.equal(manager.isActive('fixture'), false);
});

test('abort drains only owned accepted effects and requests cooperative shutdown once', async t => {
  const f = setup(t); let release, stops = 0, effects = 0;
  f.options.handleSystemCall = async () => { effects++; await new Promise(resolve => { release = resolve; }); };
  f.options.stopWorker = () => { stops++; };
  f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  f.child.emit('message', { type: 'sys_call', reqId: 'accepted', method: 'write', args: [] });
  const file = path.join(f.root, 'run.json');
  f.manager.abort('fixture', file); f.manager.abort('fixture', file);
  f.child.emit('message', { type: 'sys_call', reqId: 'late', method: 'write', args: [] });
  await tick(); assert.equal(stops, 0); assert.equal(effects, 1);
  release(); await tick(); assert.equal(stops, 1);
  assert.equal(f.manager.isActive('fixture'), true);
  f.child.emit('exit', 0);
  assert.equal(f.manager.stopState('fixture'), undefined);
  assert.equal(f.events.at(-1)[1].status, 'aborted');
  const events = fs.readFileSync(path.join(f.root, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).event, 'run_abort');
});

test('stop request failures remain visible and can be retried without reporting a live child as aborted', async t => {
  const f = setup(t); let stops = 0;
  f.options.stopWorker = () => { if (++stops === 1) throw Error('stop unavailable'); };
  f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  const file = path.join(f.root, 'run.json');
  f.manager.abort('fixture', file); await tick();
  assert.match(f.manager.stopState('fixture').error, /stop unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(file)).status, 'suspended');
  f.manager.abort('fixture', file); await tick(); assert.equal(stops, 2);
  assert.equal(f.manager.stopState('fixture').error, undefined);
  f.child.emit('exit', 0); assert.equal(JSON.parse(fs.readFileSync(file)).status, 'aborted');
});

test('completion that wins the abort race is retained, while an idle suspended run can be aborted', t => {
  const f = setup(t);
  const file = path.join(f.root, 'run.json');
  f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  f.manager.abort('fixture', file);
  fs.writeFileSync(file, JSON.stringify({ run_id: 'fixture', status: 'completed' }));
  f.child.emit('exit', 0);
  assert.equal(JSON.parse(fs.readFileSync(file)).status, 'completed');
  assert.equal(f.events.at(-1)[1].status, 'completed');
  fs.writeFileSync(file, JSON.stringify({ run_id: 'fixture', status: 'suspended' }));
  assert.equal(f.manager.abort('fixture', file), 'ok');
  assert.equal(JSON.parse(fs.readFileSync(file)).status, 'aborted');
});

test('a saved stop survives supervisor replacement and blocks continuation while the old PID exists', async t => {
  const f = setup(t); f.child.pid = process.pid; f.options.stopWorker = () => {};
  f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  f.manager.abort('fixture', path.join(f.root, 'run.json')); await tick();
  const requestedAt = f.manager.stopState('fixture').requestedAt;
  let forks = 0;
  const recovered = new WorkerSupervisor({ ...f.options, runsDir: f.root, fork: () => { forks++; return f.child; } });
  assert.equal(recovered.stopState('fixture')?.requestedAt, requestedAt);
  assert.match(recovered.stopState('fixture').error, /restart.*exit/i);
  assert.throws(() => recovered.forkResume('fixture', { runDir: f.root, humanOutput: {} }), /stopping/);
  assert.equal(recovered.abort('fixture', path.join(f.root, 'run.json')), 'ok');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'))).status, 'suspended');
  assert.equal(forks, 0);
});

test('recovery confirms an exited owned PID without replay and records only one abort', async t => {
  const child = fork('-e', ['process.exit(0)'], { execArgv: [], silent: true });
  const pid = child.pid; await once(child, 'exit');
  const f = setup(t); f.child.pid = pid; f.options.stopWorker = () => {};
  f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  f.manager.abort('fixture', path.join(f.root, 'run.json')); await tick();
  const recovered = new WorkerSupervisor({ ...f.options, runsDir: f.root });
  assert.equal(recovered.stopState('fixture'), undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'))).status, 'aborted');
  new WorkerSupervisor({ ...f.options, runsDir: f.root });
  assert.equal(fs.readFileSync(path.join(f.root, 'execution.jsonl'), 'utf8').split('\n').filter(l => l && JSON.parse(l).event === 'run_abort').length, 1);
});

test('stop persistence failure cannot acknowledge or disconnect a worker', t => {
  const f = setup(t); f.manager.forkResume('fixture', { runDir: f.root, humanOutput: {} });
  fs.mkdirSync(path.join(f.root, 'stop-request.json'));
  assert.throws(() => f.manager.abort('fixture', path.join(f.root, 'run.json')));
  assert.equal(f.manager.stopState('fixture'), undefined);
  assert.equal(f.child.connected, true);
});

test('retry after abort event append but failed status save does not append another abort', t => {
  const f = setup(t), file = path.join(f.root, 'run.json');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === file) throw new Error('fixture full disk');
    return rename(source, target);
  });
  assert.equal(f.manager.abort('fixture', file), 'ok');
  assert.match(f.manager.stopState('fixture').error, /full disk/);
  t.mock.restoreAll();
  f.manager.abort('fixture', file);
  assert.equal(JSON.parse(fs.readFileSync(file)).status, 'aborted');
  assert.equal(fs.readFileSync(path.join(f.root, 'execution.jsonl'), 'utf8').split('\n').filter(l => l && JSON.parse(l).event === 'run_abort').length, 1);
});

test('explicit failure retry launches once, rejects stale invocation and does not require Human output', t => {
 const f=setup(t);fs.writeFileSync(path.join(f.root,'run.json'),JSON.stringify({run_id:'fixture',status:'failed'}));
 fs.writeFileSync(path.join(f.root,'execution.jsonl'),[
  {event:'run_failed',node_run_id:'failed-one',failure:{safeToReplay:false}},
  {event:'suspended_state',global_seq:3,call_stack:[{frame_id:'frame',intent_name:'workflow',current_node:'review',scope_stack:[]}]}
 ].map(JSON.stringify).join('\n')+'\n');
 assert.throws(()=>f.manager.forkResume('fixture',{runDir:f.root,retryFailedNode:'old'}),/changed/);
 assert.throws(()=>f.manager.forkResume('fixture',{runDir:f.root,retryFailedNode:'failed-one',humanOutput:{}}),/without human/);
 f.manager.forkResume('fixture',{runDir:f.root,retryFailedNode:'failed-one'});
 assert.equal(f.manager.isActive('fixture'),true);
 assert.throws(()=>f.manager.forkResume('fixture',{runDir:f.root,retryFailedNode:'failed-one'}),/active worker/);
 f.child.emit('exit',0);
});
