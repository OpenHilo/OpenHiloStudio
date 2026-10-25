const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ScheduleService, ScheduleValidationError, ScheduleStorageError } = require('@openhilo/platform-services/schedule-service');
const { Scheduler } = require('@openhilo/platform-services/scheduler');
const { WorkerSystemHost } = require('@openhilo/platform-services/worker-system-host');
const input = { name: 'Daily report', cron: '0 9 * * *', ittPath: 'demo/report/report.itt.impl.json', workdir: '/explicit-workspace', inputs: { value: '3' } };
const valid = expression => /^[\d* ,/-]+$/.test(expression) && expression.trim().split(/\s+/).length === 5;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-scheduler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'nested', 'schedules.json');
  const service = new ScheduleService(filePath, { validateCron: valid, random: () => 0 });
  return { root, filePath, service };
}
function clock() {
  const timers = [];
  return { timers, validate: valid, schedule(expression, callback) {
    const timer = { expression, callback, stopped: false, stop() { this.stopped = true; } }; timers.push(timer); return timer;
  } };
}

test('concurrent schedule writes retain every record and reject invalid changes without corruption', async t => {
  const { service, filePath } = fixture(t);
  const created = await Promise.all(Array.from({ length: 20 }, (_, i) => service.create({ ...input, name: `report-${i}` })));
  assert.equal((await service.list()).length, 20);
  assert.equal(new Set(created.map(item => item.id)).size, 20);
  await Promise.all(created.map(item => service.patch(item.id, { enabled: false })));
  assert.ok((await service.list()).every(item => !item.enabled));
  const before = fs.readFileSync(filePath, 'utf8');
  await assert.rejects(service.patch(created[0].id, { id: 'overwrite' }), ScheduleValidationError);
  await assert.rejects(service.create({ ...input, cron: 'invalid' }), ScheduleValidationError);
  await assert.rejects(service.create({ ...input, enabled: null }), ScheduleValidationError);
  await assert.rejects(service.create({ ...input, inputs: { value: 3 } }), ScheduleValidationError);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  await service.delete(created[0].id); assert.equal((await service.list()).length, 19);
  fs.writeFileSync(filePath, '{corrupt');
  await assert.rejects(service.create(input), ScheduleStorageError);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{corrupt');
});

test('flexible edits recalculate assignment and receipt patches do not create timer events', async t => {
  const { service } = fixture(t), events = [];
  service.subscribe(event => { events.push(event); });
  const item = await service.create({ ...input, flexible: true });
  assert.equal(item.assignedCron, '0 9 * * *');
  const edited = await service.patch(item.id, { cron: '0 14 * * 1' });
  assert.equal(edited.assignedCron, '0 14 * * 1');
  await service.patch(item.id, { lastRunId: 'record-only' });
  assert.equal(events.length, 2);
  assert.equal((await service.patch(item.id, { flexible: false })).assignedCron, undefined);
  assert.equal(events.length, 3);
});

test('flexible schedules reject recurring clock fields without writing or changing frequency', async t => {
  const { service, filePath } = fixture(t);
  const daily = await service.create({ ...input, flexible: true });
  const before = fs.readFileSync(filePath, 'utf8');
  for (const cron of ['*/5 * * * *', '0 9,17 * * 1-5', '0 */2 * * *', '* 9 * * *', '0 9-17 * * *']) {
    await assert.rejects(service.create({ ...input, cron, flexible: true }), /single.*minute.*hour/i);
    await assert.rejects(service.patch(daily.id, { cron }), /single.*minute.*hour/i);
    assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  }
  const periodic = await service.create({ ...input, cron: '*/5 * * * *' });
  assert.equal(periodic.cron, '*/5 * * * *'); assert.equal(periodic.assignedCron, undefined);
  await assert.rejects(service.patch(periodic.id, { flexible: true }), /single.*minute.*hour/i);
});

test('legacy flexible records remain readable and disableable but cannot be re-enabled with recurring clock fields', async t => {
  const { service, filePath } = fixture(t);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify([{ ...input, id: 'legacy-recurring', cron: '*/5 * * * *', assignedCron: '0 0 * * *', flexible: true, enabled: true }]));
  assert.equal((await service.list()).length, 1);
  await service.patch('legacy-recurring', { lastRunId: 'receipt' });
  await service.patch('legacy-recurring', { enabled: false });
  await assert.rejects(service.patch('legacy-recurring', { enabled: true }), /single.*minute.*hour/i);
  const repaired = await service.patch('legacy-recurring', { flexible: false, enabled: true });
  assert.equal(repaired.cron, '*/5 * * * *'); assert.equal(repaired.assignedCron, undefined);
});

test('scheduler deduplicates registrations, rejects stale callbacks and records launch receipts', async t => {
  const { service } = fixture(t), c = clock(), launches = [], errors = [];
  const scheduler = new Scheduler({ repository: service, clock: c, launch: async options => { launches.push(options); return 'run-1'; },
    now: () => new Date('2026-09-26T12:00:00Z'), onError: error => errors.push(error) });
  t.after(() => scheduler.stop());
  const item = await service.create(input);
  await scheduler.start(); await scheduler.start(); scheduler.register(item);
  assert.equal(c.timers.length, 1);
  c.timers[0].callback(); await scheduler.drain();
  assert.equal(launches.length, 1); assert.equal(launches[0].triggeredBy, 'schedule'); assert.equal(launches[0].suspend, true);
  assert.equal((await service.list())[0].lastRunId, 'run-1');
  assert.equal((await service.list())[0].lastRunAt, '2026-09-26T12:00:00.000Z');
  assert.equal(c.timers.length, 1);
  await service.patch(item.id, { cron: '0 10 * * *' });
  assert.equal(c.timers.length, 2); assert.ok(c.timers[0].stopped);
  c.timers[0].callback(); await scheduler.drain(); assert.equal(launches.length, 1);
  await service.patch(item.id, { enabled: false });
  c.timers[1].callback(); await scheduler.drain(); assert.equal(launches.length, 1);
  scheduler.stop(); scheduler.register(item); await service.patch(item.id, { enabled: true }); assert.equal(c.timers.length, 2);
  await scheduler.start(); assert.equal(c.timers.length, 3); scheduler.stop();
  c.timers[2].callback(); await scheduler.drain(); assert.equal(launches.length, 1); assert.deepEqual(errors, []);
});

test('schedule timing follows the active clock registration and clears after disable or shutdown', async t => {
  const { service } = fixture(t);
  let next = new Date('2026-10-07T16:00:00Z');
  const scheduler = new Scheduler({ repository: service, launch: async () => 'unused',
    clock: { timeZone: 'America/New_York', validate: valid, schedule() { return { stop() {}, getNextRun: () => next }; } } });
  t.after(() => scheduler.stop());
  const item = await service.create(input);
  await scheduler.start();
  assert.deepEqual(scheduler.timing(item.id), { nextRunAt: next.toISOString(), timeZone: 'America/New_York' });
  next = new Date('2026-10-08T16:00:00Z');
  assert.equal(scheduler.timing(item.id).nextRunAt, next.toISOString());
  await service.patch(item.id, { enabled: false });
  assert.deepEqual(scheduler.timing(item.id), { timeZone: 'America/New_York' });
  await service.patch(item.id, { enabled: true });
  assert.equal(scheduler.timing(item.id).nextRunAt, next.toISOString());
  scheduler.stop();
  assert.deepEqual(scheduler.timing(item.id), { timeZone: 'America/New_York' });
  assert.deepEqual(scheduler.timing('missing'), { timeZone: 'America/New_York' });
});

test('clocks without timing support do not invent a forecast or time zone', async t => {
  const { service } = fixture(t);
  const item = await service.create(input);
  const scheduler = new Scheduler({ repository: service, clock: clock(), launch: async () => 'unused' });
  t.after(() => scheduler.stop()); await scheduler.start();
  assert.deepEqual(scheduler.timing(item.id), {});
});

test('worker-created and cancelled schedules immediately affect the running scheduler', async t => {
  const { service, root } = fixture(t), c = clock(), launches = [];
  const scheduler = new Scheduler({ repository: service, clock: c, launch: async options => { launches.push(options); return 'from-worker'; } });
  t.after(() => scheduler.stop()); await scheduler.start();
  const intentsDir = path.join(root, 'intents'), workspacesDir = path.join(root, 'workspaces');
  const directory = path.join(intentsDir, 'demo', 'report'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'report.itt.impl.json'), '{}');
  const host = new WorkerSystemHost({ entityManager: {}, scheduleService: service, intentsDir, workspacesDir });
  let response;
  const call = async (method, args) => { await host.handleSystemCall({ send: value => { response = value; } }, { type: 'sys_call', reqId: 'request', method, args }); assert.equal(response.error, undefined); return response.result; };
  const id = await call('scheduleFlexibleIntent', ['0 9 * * *', 'demo.report', { value: '7' }, null]);
  assert.equal(c.timers.length, 1); c.timers[0].callback(); await scheduler.drain();
  assert.equal(launches.length, 1); assert.deepEqual(launches[0].inputs, { value: '7' });
  assert.ok(launches[0].workdir.startsWith(workspacesDir + path.sep));
  assert.equal(await call('cancelSchedulor', [id]), true); assert.ok(c.timers[0].stopped);
  c.timers[0].callback(); await scheduler.drain(); assert.equal(launches.length, 1); assert.deepEqual(await service.list(), []);
});

test('stopping during asynchronous startup prevents late registration and permits a fresh start', async () => {
  let finish; const oldList = new Promise(resolve => { finish = resolve; }), c = clock(); let reads = 0;
  const item = { ...input, id: 'existing', enabled: true };
  const scheduler = new Scheduler({ repository: { list: () => ++reads === 1 ? oldList : Promise.resolve([item]), patch: async () => null }, clock: c, launch: async () => 'unused' });
  const first = scheduler.start(); scheduler.stop(); await scheduler.start();
  assert.equal(c.timers.length, 1); finish([item]); await first; assert.equal(c.timers.length, 1); scheduler.stop();
});

test('failed launches are reported without replay and drain waits for in-flight receipts', async t => {
  const { service } = fixture(t), c = clock(), errors = []; let fail;
  const scheduler = new Scheduler({ repository: service, clock: c, launch: () => new Promise((_resolve, reject) => { fail = reject; }), onError: error => errors.push(error.message) });
  await service.create(input); await scheduler.start(); c.timers[0].callback();
  while (!fail) await new Promise(resolve => setImmediate(resolve));
  scheduler.stop();
  let drained = false; const waiting = scheduler.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); fail(new Error('launch failed')); await waiting;
  assert.deepEqual(errors, ['launch failed']); assert.equal((await service.list())[0].lastRunId, undefined);
});

test('startup snapshot cannot overwrite changes delivered while the repository loads', async () => {
  let finish, notify; const snapshot = new Promise(resolve => { finish = resolve; }); const c = clock();
  const item = { ...input, id: 'edited', enabled: true }, removed = { ...input, id: 'removed', enabled: true };
  const scheduler = new Scheduler({ repository: { list: () => snapshot, patch: async () => null,
    subscribe(listener) { notify = listener; return () => {}; } }, clock: c, launch: async () => 'unused' });
  const started = scheduler.start();
  notify({ type: 'upsert', schedule: { ...item, cron: '0 11 * * *' } }); notify({ type: 'delete', id: removed.id });
  finish([item, removed]); await started;
  assert.equal(c.timers.length, 1); assert.equal(c.timers[0].expression, '0 11 * * *'); scheduler.stop();
});

test('failed schedule writes retain disk state and do not emit a committed change', async t => {
  const { service, filePath } = fixture(t), events = [];
  service.subscribe(event => events.push(event)); const item = await service.create(input);
  const rename = fs.renameSync; fs.renameSync = () => { throw new Error('fixture rename failure'); };
  try { await assert.rejects(service.delete(item.id), /fixture rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(events.length, 1); assert.equal((await service.list())[0].id, item.id);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['schedules.json']);
  await service.delete(item.id); assert.equal(events.length, 2);
});

test('standalone scheduling imports do not choose cron, workers, AI providers or application modules', () => {
  const { spawnSync } = require('node:child_process');
  const script = `const Module = require('node:module'); const load = Module._load;
    Module._load = function(name, ...args) {
      if (/node-cron|worker-supervisor|ai-claude-code|ai-sdk|@intentorch|better-sqlite3|node-pty/.test(name)) throw new Error('Forbidden dependency: ' + name);
      return load.call(this, name, ...args);
    };
    require('@openhilo/platform-services/scheduler'); require('@openhilo/platform-services/schedule-service');`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('legacy schedule ids, history, unknown metadata and unassigned flexible records survive edits', async t => {
  const { service, filePath } = fixture(t), c = clock();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const legacy = { ...input, id: 'old-id', enabled: true, flexible: true, lastRunId: 'historic-run', lastRunAt: '2026-01-02T03:04:05.000Z', extraMetadata: { retained: true } };
  fs.writeFileSync(filePath, JSON.stringify([legacy]));
  const scheduler = new Scheduler({ repository: service, clock: c, launch: async () => 'new-run' });
  t.after(() => scheduler.stop()); await scheduler.start();
  assert.equal(c.timers[0].expression, legacy.cron);
  await service.patch('old-id', { enabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), [{ ...legacy, enabled: false }]);
});


test('changing only the input encoding replaces a timer and persists the selected decoding', async t => {
  const { service } = fixture(t), c = clock(), launches = [];
  const scheduler = new Scheduler({ repository: service, clock: c, launch: async options => { launches.push(options); return 'typed'; } });
  t.after(() => scheduler.stop());
  const item = await service.create(input); await scheduler.start();
  await service.patch(item.id, { inputEncoding: 'typed-text-v1' });
  assert.equal(c.timers.length, 2); assert.equal(c.timers[0].stopped, true);
  c.timers[0].callback(); await scheduler.drain(); assert.equal(launches.length, 0);
  c.timers[1].callback(); await scheduler.drain();
  assert.equal(launches[0].inputEncoding, 'typed-text-v1');
  assert.equal((await service.list())[0].inputEncoding, 'typed-text-v1');
  await assert.rejects(service.patch(item.id, { inputEncoding: 'future' }), ScheduleValidationError);
  assert.equal(c.timers.length, 2);
});

test('target preflight rejects before persistence; async checks retain serialized mutations', async t => {
  const f = fixture(t); const events = []; let checks = 0;
  const service = new ScheduleService(f.filePath, { validateCron: valid, async validateTarget(schedule) {
    await new Promise(resolve => setImmediate(resolve)); checks++;
    if (schedule.ittPath === 'missing') throw new ScheduleValidationError('Target missing');
  } });
  service.subscribe(event => events.push(event));
  const pending = [service.create({ ...input, ittPath: 'missing' }), service.create(input)];
  await assert.rejects(pending[0], /Target missing/);
  const created = await pending[1];
  assert.equal((await service.list()).length, 1); assert.equal(events.length, 1); assert.equal(checks, 2);
  const before = fs.readFileSync(f.filePath, 'utf8');
  await assert.rejects(service.patch(created.id, { ittPath: 'missing' }), /Target missing/);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), before);
});

test('an unavailable existing target may still be read, disabled, and have launch receipts recorded', async t => {
  const f = fixture(t); let available = true;
  const service = new ScheduleService(f.filePath, { validateCron: valid, validateTarget() { if (!available) throw new ScheduleValidationError('Target missing'); } });
  const created = await service.create(input); available = false;
  assert.equal((await service.list()).length, 1);
  await service.patch(created.id, { lastRunId: 'already-started' });
  await service.patch(created.id, { enabled: false });
  await assert.rejects(service.patch(created.id, { enabled: true }), /Target missing/);
  assert.equal((await service.list())[0].enabled, false);
});


test('launch receipts persist pending, failure and recovery without losing prior successful run history', async t => {
  const { service, filePath } = fixture(t), c = clock(); let reject, resolve, calls = 0;
  const scheduler = new Scheduler({ repository: service, clock: c, onError() {}, launch: () => {
    calls++; return new Promise((yes, no) => { resolve = yes; reject = no; });
  } });
  t.after(() => scheduler.stop());
  const item = await service.create(input); await scheduler.start();
  await service.patch(item.id, { lastRunId: 'old-run', lastRunAt: '2026-01-01T00:00:00Z' });
  c.timers[0].callback();
  while (!reject) await new Promise(done => setImmediate(done));
  assert.equal((await service.list())[0].lastAttempt.status, 'pending');
  c.timers[0].callback(); assert.equal(calls, 1, 'pending launch cannot overlap another trigger');
  reject(new Error('workflow disappeared')); await scheduler.drain();
  let saved = (await service.list())[0];
  assert.equal(saved.lastAttempt.status, 'failed'); assert.equal(saved.lastAttempt.error, 'workflow disappeared');
  assert.equal(saved.lastRunId, 'old-run');
  const reopened = new ScheduleService(filePath, { validateCron: valid });
  assert.equal((await reopened.list())[0].lastAttempt.error, 'workflow disappeared');
  reject = undefined; c.timers[0].callback();
  while (!reject) await new Promise(done => setImmediate(done));
  resolve('new-run'); await scheduler.drain(); saved = (await service.list())[0];
  assert.equal(saved.lastAttempt.status, 'launched'); assert.equal(saved.lastAttempt.error, undefined);
  assert.equal(saved.lastRunId, 'new-run'); assert.equal(c.timers.length, 1);
});

test('receipt storage failure does not claim a created run failed and never automatically relaunches', async t => {
  const { service } = fixture(t), c = clock(), errors = []; let calls = 0;
  const scheduler = new Scheduler({ clock: c, repository: {
    list: () => service.list(), subscribe: listener => service.subscribe(listener),
    patch: (id, patch) => { if (patch.lastAttempt.status !== 'pending') throw new Error('disk unavailable'); return service.patch(id, patch); },
  }, launch: async () => { calls++; return 'created-run'; }, onError: error => errors.push(error.message) });
  t.after(() => scheduler.stop()); const item = await service.create(input); await scheduler.start();
  c.timers[0].callback(); await scheduler.drain();
  assert.equal(calls, 1); assert.equal((await service.list())[0].lastAttempt.status, 'pending');
  assert.equal(scheduler.timing(item.id).lastAttempt.status, 'unknown');
  assert.equal(scheduler.timing(item.id).lastAttempt.runId, 'created-run');
  assert.ok(errors.includes('disk unavailable'));
  scheduler.stop(); await scheduler.start(); assert.equal(calls, 1);
});
