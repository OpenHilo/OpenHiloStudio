const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLocalDeployment } = require('@openhilo/server/local-deployment');
const { EntityStore } = require('@openhilo/platform-services/entity-store');
const demoDir = path.join(path.dirname(require.resolve('@openhilo/server')), '..', 'examples/offline-demo');
const { initializeDemo } = require(path.join(demoDir, 'host.cjs'));
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-deployment-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true })); initializeDemo(home);
  let registered = 0, stopped = 0, calls = 0, storeCloses = 0;
  return { home, counts: () => ({ registered, stopped, calls, storeCloses }), options: {
    home, aiExecutor: { id: 'offline', capabilities: [], start() { calls++; throw new Error('No AI request is expected'); } },
    launch() { throw new Error('No worker launch is expected'); },
    clock: { validate: expression => expression === '* * * * *', schedule() { registered++; return { stop() { stopped++; } }; } },
    createStore(file) { const store = new EntityStore(file), close = store.close.bind(store); store.close = () => { storeCloses++; close(); }; return store; },
    configuration: { read: () => ({ selected: 'offline' }), update: value => value },
  } };
}
test('a home admits one owner, including aliases, and can reopen after close', async t => {
  const f = fixture(t), host = await createLocalDeployment(f.options);
  t.after(() => host.close());
  const alias = f.home + '-alias'; fs.symlinkSync(f.home, alias);
  t.after(() => fs.rmSync(alias, { force: true }));
  let opened = 0;
  for (const home of [f.home, alias]) {
    await assert.rejects(createLocalDeployment({ ...f.options, home, createStore() { opened++; throw Error('Should not open'); } }), /already.*(open|owned|use)|another.*(owner|deployment)/i);
  }
  assert.equal(opened, 0, 'reject before opening any writable deployment resource');
  await host.close();
  const reopened = await createLocalDeployment(f.options); await reopened.close();
});

test('failed store construction and extension registration release home ownership', async t => {
  const f = fixture(t);
  await assert.rejects(createLocalDeployment({ ...f.options, createStore() { throw Error('Store failed'); } }), /Store failed/);
  await assert.rejects(createLocalDeployment({ ...f.options, registerExtensions() { throw Error('Extension failed'); } }), /Extension failed/);
  const host = await createLocalDeployment(f.options); await host.close();
});

test('home ownership remains held while shutdown drains work', async t => {
  const f = fixture(t), host = await createLocalDeployment(f.options);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const draining = new Promise(resolve => { entered = resolve; });
  const close = host.workers.close.bind(host.workers);
  host.workers.close = async () => { entered(); await gate; await close(); };
  t.after(async () => { release(); await host.close(); });
  const closing = host.close(); await draining;
  await assert.rejects(createLocalDeployment(f.options), /already.*(open|owned|use)|another.*(owner|deployment)/i);
  release(); await closing;
  const reopened = await createLocalDeployment(f.options); await reopened.close();
});

test('another process cannot own the home and a killed owner leaves no stale lock', { timeout: 15000 }, async t => {
  const { fork } = require('node:child_process');
  const { once } = require('node:events');
  const f = fixture(t);
  const child = fork(path.join(__dirname, 'support/local-owner.cjs'), [f.home], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } });
  const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw Error(`Owner exited early: ${code}`); })]);
  assert.equal(ready[0], 'ready');
  await assert.rejects(createLocalDeployment(f.options), /already.*(open|owned|use)|another.*(owner|deployment)/i);
  const other = fixture(t), independent = await createLocalDeployment(other.options); await independent.close();
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  const recovered = await createLocalDeployment(f.options); await recovered.close();
});
test('failed shutdown retains home ownership through garbage collection until process exit', { timeout: 15000 }, async t => {
  const { fork } = require('node:child_process');
  const { once } = require('node:events');
  const f = fixture(t);
  const child = fork(path.join(__dirname, 'support/local-owner.cjs'), [f.home, 'failed-drain-gc'], {
    execArgv: ['--expose-gc'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } });
  const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw Error(`Owner exited early: ${code}\n${stderr}`); })]);
  assert.equal(ready[0], 'ready');
  let replacement;
  t.after(async () => { await replacement?.close(); });
  await assert.rejects(async () => { replacement = await createLocalDeployment(f.options); }, /already.*(open|owned|use)|another.*(owner|deployment)/i);
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  replacement = await createLocalDeployment(f.options); await replacement.close();
});
test('composition opens unseeded storage without timers/listener and owns explicit timer startup and close', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.home, 'schedules.json'), JSON.stringify([{ id: 'scheduled', name: 'scheduled', enabled: true, cron: '* * * * *', ittPath: 'entry.itt.json', workdir: f.home, inputs: {} }]));
  const host = await createLocalDeployment(f.options); t.after(() => host.close());
  assert.equal(host.app.server.listening, false); assert.equal(f.counts().registered, 0);
  assert.deepEqual((await host.app.inject('/api/tag-definitions')).json(), []);
  assert.deepEqual((await host.app.inject('/api/config')).json(), { selected: 'offline' });
  await host.startSchedules(); await host.startSchedules(); assert.equal(f.counts().registered, 1);
  await host.app.close();
  await assert.rejects(host.startSchedules(), /closed/);
  await host.close(); assert.deepEqual(f.counts(), { registered: 1, stopped: 1, calls: 0, storeCloses: 1 });
});
test('extension registration and timer startup failures close owned stores once', async t => {
  const f = fixture(t);
  await assert.rejects(createLocalDeployment({ ...f.options, registerExtensions() { throw new Error('Extension rejected'); } }), /Extension rejected/);
  assert.equal(f.counts().storeCloses, 1);
  const g = fixture(t); fs.writeFileSync(path.join(g.home, 'schedules.json'), JSON.stringify([{ id: 'scheduled', name: 'scheduled', enabled: true, cron: '* * * * *', ittPath: 'entry.itt.json', workdir: g.home, inputs: {} }]));
  const host = await createLocalDeployment({ ...g.options, clock: { validate: () => true, schedule() { throw new Error('Clock failed'); } } });
  await assert.rejects(host.startSchedules(), /Clock failed/); assert.equal(g.counts().storeCloses, 1);
  await assert.rejects(host.workers.forkRun({ ittPath: 'entry', workdir: g.home, inputs: {} }), /shutting down|closed/);
});
test('reading and responding to interrupted saved generation never reconnects or replays AI', async t => {
  const f = fixture(t), host = await createLocalDeployment(f.options); t.after(() => host.close());
  const snapshot = { id: 'interrupted', config: { workspace: host.paths.brainDir, publicationDir: host.paths.intentsDir, sessionDir: path.join(f.home, 'sessions/interrupted'), maxClarificationRounds: 2, maxFeedbackRounds: 3 },
    sessionDir: path.join(f.home, 'sessions/interrupted'), phase: 'cc_waiting_for_answer', round: 1, feedbackRoundsUsed: 0, naturalLanguage: 'already started', aiExecutorId: 'offline', pendingMcpQuestion: { id: 'q1', question: 'Retain this question' } };
  await host.storage.save(snapshot.id, snapshot);
  const before = fs.readFileSync(path.join(snapshot.sessionDir, 'session.json'));
  const step = await host.generation.read(snapshot.id); assert.equal(step.phase, 'error'); assert.equal(step.retryable, false); assert.match(step.message, /no attempt was replayed/);
  assert.deepEqual(fs.readFileSync(path.join(snapshot.sessionDir, 'session.json')), before);
  assert.deepEqual(await host.generation.respond(snapshot.id, { type: 'retry' }), step);
  assert.equal(f.counts().calls, 0);
  const oldDir = path.join(f.home, 'old-owned-by-another-host');
  await host.storage.save(snapshot.id, { ...snapshot, sessionDir: oldDir });
  // Read remains non-mutating, but continuation must not persist through the old pointer.
  assert.equal((await host.generation.read(snapshot.id)).phase, 'error');
  await assert.rejects(host.generation.respond(snapshot.id, { type: 'retry' }), /paths/);
  assert.equal(fs.existsSync(oldDir), false);
});
test('saved review rejects changed executor, policy or workspace before publication', async t => {
  const f = fixture(t), host = await createLocalDeployment(f.options); t.after(() => host.close());
  const base = { id: 'review', config: { workspace: host.paths.brainDir, publicationDir: host.paths.intentsDir, sessionDir: path.join(f.home, 'sessions/review'), maxClarificationRounds: 2, maxFeedbackRounds: 3 }, sessionDir: path.join(f.home, 'sessions/review'), phase: 'confirm_merge', round: 1, feedbackRoundsUsed: 0, naturalLanguage: 'review', aiExecutorId: 'offline', pendingEntries: [], pendingPreflight: { ok: true, added: [], modified: [], deleted: [], diffs: {}, contents: {} } };
  for (const [change, message] of [[{ aiExecutorId: 'another' }, /executor/], [{ generationPolicyIdentity: { namespace: 'different', version: 1 } }, /policy/], [{ config: { ...base.config, workspace: '/previous/brain' } }, /paths/]]) {
    await host.storage.save(base.id, { ...base, ...change });
    await assert.rejects(host.generation.respond(base.id, { type: 'merge_approve' }), message);
  }
  assert.equal(f.counts().calls, 0);
});
test('generation rejects a different workspace before AI starts and home is always explicit', async t => {
  const f = fixture(t), host = await createLocalDeployment(f.options); t.after(() => host.close());
  await assert.rejects(host.generation.start({ naturalLanguage: 'work', workspace: '/another/brain' }), /configured brain workspace/);
  await assert.rejects(createLocalDeployment({ ...f.options, home: '.' }), /absolute home/);
  assert.equal(f.counts().calls, 0);
});

test('HTTP schedule validation rejects unusable targets before registration and retains valid falsy inputs', async t => {
  const f = fixture(t), host = await createLocalDeployment(f.options); t.after(() => host.close());
  const file = path.join(f.home, 'qa.itt.impl.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, entry: 'done', nodes: { done: { id: 'done', type: 'assign', assignments: [], next: 'END' } }, inputs: { count: { kind: 'number' }, enabled: { kind: 'boolean' } } }));
  const input = { name: 'qa validation', cron: '* * * * *', ittPath: file, workdir: path.join(f.home, 'not-created'), inputs: { count: '0', enabled: 'false' }, inputEncoding: 'typed-text-v1', enabled: true };
  for (const changes of [{ ittPath: file + '.missing' }, { workdir: 'relative' }, { inputs: {} }, { inputs: { count: 'NaN', enabled: 'false' } }]) {
    const response = await host.app.inject({ method: 'POST', url: '/api/schedules', payload: { ...input, ...changes } });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.deepEqual(await host.schedules.list(), []); assert.equal(f.counts().registered, 0);
  const response = await host.app.inject({ method: 'POST', url: '/api/schedules', payload: input });
  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(response.json().inputs, input.inputs); assert.equal(response.json().inputEncoding, 'typed-text-v1');
  assert.equal(fs.existsSync(input.workdir), false);
  fs.renameSync(file, file + '.unavailable');
  const id = response.json().id;
  assert.equal((await host.app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, payload: { enabled: false } })).statusCode, 200);
  assert.equal((await host.app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, payload: { enabled: true } })).statusCode, 400);
  assert.equal((await host.schedules.list())[0].enabled, false);
});
