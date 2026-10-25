const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EntityStore, CasConflictError, createSysExecutor, Snapshotter, platformSystemMethods } = require('../dist');
const { FailableError } = require('@openhilo/runtime-contracts');
const { runExample } = require('../examples/entities.cjs');
const node = (method, outputs = { result: 'json' }) => ({ id: 'call', type: 'call', executor: 'sys', callee: method, inputsFrom: {}, outputsTo: {}, outputs, next: 'END' });
const caller = { caller: 'executor_sys' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-platform-package-'));
  const store = new EntityStore(path.join(dir, 'entities.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

test('generic storage, system writes and task tools preserve a record across reopen without domain seeds', async () => {
  const result = await runExample();
  assert.equal(result.entity.data.title, 'Updated');
  assert.equal(result.entity.version, 2);
  assert.deepEqual(result.entity.tags, {});
  assert.deepEqual(result.definitions, []);
});

test('CAS conflicts preserve data and use the shared public error identity', t => {
  const { store } = fixture(t);
  store.defineClass('Note', {}, 'Note', {});
  const { id } = store.createEntity('Note', 'one', { count: 1 }, 'One', {});
  store.updateEntityField(id, '$.count', 2, 1);
  assert.throws(() => store.updateEntityField(id, '$.count', 3, 1), error => error instanceof CasConflictError && error instanceof FailableError);
  assert.equal(store.getEntity(id).data.count, 2);
});

test('schedule methods require explicit storage and workspace paths, with no hidden home fallback', async t => {
  const { store, dir } = fixture(t);
  const args = { cron: '0 9 * * *', intentName: 'report', params: {} };
  await assert.rejects(createSysExecutor({ mode: 'direct', entityManager: store })(node('scheduleIntent'), args, caller), /storage path is not configured/);
  const scheduleFilePath = path.join(dir, 'schedules.json');
  const execute = createSysExecutor({ mode: 'direct', entityManager: store, scheduleFilePath });
  await assert.rejects(execute(node('scheduleIntent'), args, caller), /workdir or workspacesDir/);
  assert.equal(fs.existsSync(scheduleFilePath), false);
  const result = await execute(node('scheduleIntent', { result: 'text' }), { ...args, workdir: dir }, caller);
  const saved = JSON.parse(fs.readFileSync(scheduleFilePath, 'utf8'));
  assert.equal(saved[0].id, result.outputs.result);
  assert.equal(saved[0].workdir, dir);
});

test('explicit workspace allocation and flexible schedule retain existing wire format', async t => {
  const { store, dir } = fixture(t);
  const scheduleFilePath = path.join(dir, 'schedules.json');
  const workspacesDir = path.join(dir, 'workspaces');
  const execute = createSysExecutor({ mode: 'direct', entityManager: store, scheduleFilePath, workspacesDir });
  const { outputs } = await execute(node('scheduleFlexibleIntent', { result: 'text' }), { cron: '* 9 * * *', intentName: 'report', params: {} }, caller);
  const [saved] = JSON.parse(fs.readFileSync(scheduleFilePath, 'utf8'));
  assert.ok(saved.workdir.startsWith(workspacesDir + path.sep));
  assert.ok(fs.statSync(saved.workdir).isDirectory());
  assert.equal(saved.flexible, true); assert.ok(saved.assignedCron);
  await execute(node('cancelSchedulor', { result: 'boolean' }), { schedulorId: outputs.result }, caller);
  assert.deepEqual(JSON.parse(fs.readFileSync(scheduleFilePath, 'utf8')), []);
});

test('system writes still require an authorized caller and prototype names are not capabilities', async t => {
  const { store } = fixture(t);
  const execute = createSysExecutor({ mode: 'direct', entityManager: store });
  await assert.rejects(execute(node('createEntity'), {}, { caller: 'executor_ai' }), /Permission denied/);
  for (const name of ['__proto__', 'toString']) await assert.rejects(execute(node(name), {}, caller), /Unknown _by_sys/);
  assert.ok(platformSystemMethods.createEntity.params.includes('initData'));
});

test('legacy Brain snapshot collection requires explicit home and copies required callees', t => {
  const { dir } = fixture(t);
  assert.throws(() => new Snapshotter({ entryFile: 'main.json', snapshotDir: dir }), /explicit ittHome/);
  const calleeDir = path.join(dir, 'intents', 'child'); fs.mkdirSync(calleeDir, { recursive: true });
  const child = { version: 2, entry: 'END', nodes: {} };
  fs.writeFileSync(path.join(calleeDir, 'child.itt.impl.json'), JSON.stringify(child));
  const entryFile = path.join(dir, 'main.itt.impl.json');
  fs.writeFileSync(entryFile, JSON.stringify({ version: 2, entry: 'call', nodes: {
    call: { id: 'call', type: 'call', executor: 'intent', callee: 'child', inputsFrom: {}, outputsTo: {}, next: 'END' },
  } }));
  const snapshotDir = path.join(dir, 'snapshot'); fs.mkdirSync(snapshotDir);
  new Snapshotter({ entryFile, snapshotDir, ittHome: dir }).collect();
  assert.deepEqual(fs.readdirSync(snapshotDir).sort(), ['child.itt.impl.json', 'main.itt.impl.json']);
});

test('entity writes reject lossy JSON and invalid record shapes before changing persistent state', t => {
  const { store } = fixture(t);
  store.defineClass('Note', {}, 'Note', {});
  for (const data of [[], 'text', null, { value: Infinity }, { value: undefined }, { values: [, 1] }]) {
    assert.throws(() => store.createEntity('Note', 'invalid', data, 'Invalid', {}), /JSON object/);
    assert.deepEqual(store.queryEntities('Note'), []);
  }
  assert.throws(() => store.defineClass('Invalid', { value: NaN }, 'Invalid', {}), /JSON object/);
  assert.deepEqual(store.queryClasses().map(c => c.name), ['Note']);
  const { id } = store.createEntity('Note', 'valid', { count: 1 }, 'Valid', {});
  for (const value of [NaN, Infinity, undefined, { value: undefined }]) {
    assert.throws(() => store.updateEntityField(id, '$.count', value, 1), /JSON value/);
    assert.equal(store.getEntity(id).version, 1);
    assert.deepEqual(store.getEntity(id).data, { count: 1 });
  }
  const { EntityService } = require('../dist/entity-service');
  assert.throws(() => new EntityService(store).updateEntity(id, { count: 2, invalid: NaN }), /JSON object/);
  assert.deepEqual(store.getEntity(id).data, { count: 1 });
});

test('AI catalogue preserves public leaf metadata at arbitrary namespace depth and resolves exact qualified names', async t => {
  const { dir, store } = fixture(t), root = path.join(dir, 'intents');
  const { createPlatformReadTools } = require('../dist/tools/reads');
  const write = (relative, data) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  const base = 'a/b/c/d/module';
  write(`${base}/entry/entry.itt.json`, { desc: 'Public signature', tags: { purpose: 'review' }, inputs: { seed: { kind: 'number' } }, outputs: { value: 'number' } });
  write(`${base}/entry/entry.itt.impl.json`, { inputs: { seed: { kind: 'number' } }, outputs: { value: 'localValue' }, entry: 'END', nodes: {} });
  write(`${base}/hidden/hidden.itt.json`, { public: false });
  write(`${base}/hidden/hidden.itt.impl.json`, { entry: 'END', nodes: {} });
  write('lab/deeper/other/other.itt.json', { desc: 'Different namespace' });
  fs.symlinkSync(root, path.join(root, 'cycle'));
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.itt.json'), '{}');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const tools = Object.fromEntries(createPlatformReadTools(store, root).map(tool => [tool.name, tool.handler]));
  assert.deepEqual(await tools.queryIntents({ conditions: [{ tag: 'purpose', values: ['review'] }] }), [{ name: 'entry', namespace: 'a.b.c.d.module', desc: 'Public signature', tags: { purpose: 'review' } }]);
  assert.equal((await tools.queryIntents({})).some(intent => intent.name === 'hidden'), false);
  assert.deepEqual(await tools.queryIntentInfo({ intentName: 'a.b.c.d.module.entry' }), { name: 'entry', desc: 'Public signature', inputs: { seed: { kind: 'number' } }, outputs: { value: 'number' } });
  assert.ok((await tools.queryIntentInfo({ intentName: 'lab.other' })).error);
});
