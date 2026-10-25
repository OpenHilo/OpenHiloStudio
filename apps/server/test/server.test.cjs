const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
// This same test runs against an installed tarball outside the repository.
const load = Module._load;
Module._load = function(name, ...args) {
  if (/@intentorch|ai-claude-code|ai-sdk|@anthropic-ai|^openai$|claude-pool|ipc-server/.test(name)) {
    throw new Error(`Unexpected provider/domain dependency: ${name}`);
  }
  return load.call(this, name, ...args);
};
const { createServer } = require('@openhilo/server');
const { resolveFileRefs } = require('@openhilo/server/routes/runs');
const { Broadcaster } = require('@openhilo/platform-services/broadcaster');
const { FilterService } = require('@openhilo/platform-services/filter-service');
const { ScheduleService } = require('@openhilo/platform-services/schedule-service');
const { Scheduler } = require('@openhilo/platform-services/scheduler');
const { ConfigurationInputError } = require('@openhilo/platform-services/configuration-service');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-http-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = Object.fromEntries(['runsDir', 'intentsDir', 'brainDir', 'workspacesDir'].map(key => [key, path.join(home, key)]));
  const calls = [], active = new Set(), timers = new Set();
  const schedules = new ScheduleService(path.join(home, 'schedules.json'), { validateCron: value => value === '* * * * *' });
  const workers = {
    async forkRun(value) { calls.push(['run', value]); return 'new-run'; },
    forkResume(...args) { calls.push(['resume', ...args]); },
    abort(...args) { calls.push(['abort', ...args]); return 'aborted'; },
    isActive(id) { return active.has(id); }, activeRunIds() { return active; },
    async answerAiQuestion(...args) { calls.push(['answer', ...args]); return { accepted: true }; },
    queryIntents() { return [{ name: 'demo', desc: 'Demo', tags: {} }]; },
    queryIntentInfo(name) { return { name, inputs: {}, outputs: {} }; }, scheduleService: schedules,
  };
  const scheduler = new Scheduler({ repository: schedules, launch: value => workers.forkRun(value), clock: {
    timeZone: 'UTC',
    validate: value => value === '* * * * *',
    schedule(_cron, callback) { timers.add(callback); return { stop() { timers.delete(callback); }, getNextRun: () => new Date('2030-01-01T00:00:00Z') }; },
  } });
  const broadcaster = new Broadcaster();
  let config = { mode: 'offline' }, closed = 0;
  const options = {
    paths, workers, broadcaster, schedules, scheduler,
    filters: new FilterService(path.join(home, 'filters.json')),
    entities: { listClasses: () => [], getTagDefinitions: () => [] },
    configuration: {
      read: () => config,
      update(value) { if (!value || typeof value.mode !== 'string') throw new ConfigurationInputError('mode required'); return config = { mode: value.mode }; },
    },
    generation: {
      async start(input) { calls.push(['generate', input]); return { sessionId: 'session', step: { type: 'clarify', questions: ['Which input?'] } }; },
      async respond(id, input) { calls.push(['respond', id, input]); return { type: 'done' }; },
      async read(id) { return id === 'session' ? { type: 'done' } : undefined; },
    },
    async close() { closed++; scheduler.stop(); await scheduler.drain(); },
  };
  function write(relative, value) { const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; }
  return { home, paths, options, calls, active, timers, write, closed: () => closed };
}
async function server(t, f, extras = {}) {
  const app = await createServer({ ...f.options, ...extras });
  t.after(() => app.close());
  return app;
}

test('human inbox includes requests beyond 100 and exposes accepted decisions and output schemas', async t => {
  const f = fixture(t);
  for (let index = 0; index < 101; index++) {
    const id = `human-${index}`, base = `runsDir/${id}`, taskId = `task-${index}`;
    f.write(`${base}/run.json`, { run_id: id, intent: 'review', workdir: '/tmp/qa', status: 'suspended', created_at: new Date(1700000000000 + index * 1000).toISOString() });
    f.write(`${base}/.snapshot/review.itt.impl.json`, { nodes: { ask: { executor: 'human', intent: 'Confirm', outputsTo: { ok: 'ok' }, outputs: { ok: 'boolean' } } } });
    f.write(`${base}/human-tasks/${taskId}/request.json`, { version: 1, taskId, runId: id, nodeId: 'ask', nodeRunId: `node-${index}`, prompt: 'Confirm', inputs: {}, outputs: { ok: 'boolean' }, createdAt: '2026-10-11' });
    f.write(`${base}/execution.jsonl`, [
      { event: 'node_suspended', node_run_id: `node-${index}`, task_id: taskId, ts: 1700000000 + index },
      { event: 'suspended_state', ts: 1700000000 + index, call_stack: [{ current_node: 'ask', intent_name: 'review', scope_stack: [] }] },
    ].map(JSON.stringify).join('\n'));
    if (!index) f.write(`${base}/human-tasks/${taskId}/submission.json`, { taskId, submissionId: 'accepted', outputs: { ok: 'false' } });
  }
  const app = await server(t, f), response = await app.inject('/api/human-todos');
  assert.equal(response.statusCode, 200);
  const todos = response.json(); assert.equal(todos.length, 101);
  assert.deepEqual(todos.find(t => t.runId === 'human-0').acceptedSubmission.outputs, { ok: 'false' });
  assert.deepEqual(todos.find(t => t.runId === 'human-100').outputs, [{ name: 'ok', kind: 'boolean' }]);
});

test('schedule metadata exposes the host timezone before the first schedule exists', async t => {
  const f = fixture(t), app = await server(t, f);
  assert.deepEqual((await app.inject('/api/schedules')).json(), []);
  const response = await app.inject('/api/schedules/meta');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { timeZone: 'UTC' });
  const unknown = await server(t, fixture(t), { scheduler: { register() {}, update() {}, unregister() {} } });
  assert.deepEqual((await unknown.inject('/api/schedules/meta')).json(), { timeZone: null });
});

test('explicit shutdown drains may exceed the framework default plugin timeout', async t => {
  const f = fixture(t); let drained = false;
  const app = await server(t, f, { registerExtensions(app) {
    app.addHook('preClose', async () => { await new Promise(resolve => setTimeout(resolve, 11000)); drained = true; });
  } });
  await assert.doesNotReject(() => app.close());
  assert.equal(drained, true);
  assert.equal(f.closed(), 1);
});

test('history rejects invalid filters with HTTP 400 and preserves valid empty results', async t => {
  const f = fixture(t), app = await server(t, f);
  for (const query of ['status=invalid-status', 'createdAfter=not-a-date', 'createdBefore=not-a-date',
    'createdAfter=2026-10-11&createdBefore=2026-10-10']) {
    const response = await app.inject(`/api/runs?${query}`);
    assert.equal(response.statusCode, 400);
    assert.match(response.json().message ?? response.json().error, /filter/i);
  }
  const empty = await app.inject('/api/runs?status=completed');
  assert.equal(empty.statusCode, 200); assert.equal(empty.json().total, 0);
});

test('long qualified intent names reach schema lookup while route parameters remain bounded', async t => {
  const f = fixture(t), lookedUp = [];
  f.options.workers.queryIntentInfo = name => { lookedUp.push(name); return { name, inputs: {}, outputs: {} }; };
  const app = await server(t, f);
  const name = 'long_namespace_'.repeat(8) + '.' + 'long_workflow_'.repeat(12);
  const response = await app.inject(`/api/intents/${encodeURIComponent(name)}`);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().name, name);
  assert.deepEqual(lookedUp, [name]);
  assert.equal((await app.inject('/api/intents/' + 'x'.repeat(4097))).statusCode, 414);
  assert.deepEqual(lookedUp, [name]);
});

test('generic composition is inert, isolated and has no implicit application/provider endpoints', async t => {
  const f = fixture(t), app = await server(t, f);
  assert.equal(app.server.listening, false);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual((await app.inject('/api/application')).json(), { version: 1, id: 'generic', title: 'OpenHilo', tags: {} });
  assert.deepEqual((await app.inject('/api/studio-capabilities')).json(), { version: 1, features: [] });
  for (const url of ['/api/claude-status', '/api/config/validate', '/api/unknown']) assert.equal((await app.inject(url)).statusCode, 404);
  assert.deepEqual((await app.inject('/api/classes')).json(), []);
  assert.deepEqual((await app.inject('/api/intents')).json(), [{ name: 'demo', desc: 'Demo', tags: {} }]);
  assert.deepEqual((await app.inject('/api/config')).json(), { mode: 'offline' });
  assert.equal((await app.inject({ method: 'PUT', url: '/api/config', payload: {} })).statusCode, 400);
  assert.deepEqual((await app.inject({ method: 'PUT', url: '/api/config', payload: { mode: 'other' } })).json(), { mode: 'other' });
  const other = fixture(t), second = await server(t, other);
  assert.deepEqual((await second.inject('/api/config')).json(), { mode: 'offline' });
  const suggestion = (await app.inject('/api/runs/suggest-workdir?intent=demo')).json();
  assert.equal(path.relative(f.paths.workspacesDir, suggestion.workdir).startsWith('demo/'), true);
  await app.close(); assert.equal(f.closed(), 1);
});

test('generation ports retain start, poll, legacy save and error behavior', async t => {
  const f = fixture(t), app = await server(t, f);
  for (const payload of [{}, { naturalLanguage: ' ' }, { naturalLanguage: 'work', workspace: 2 }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/translate/start', payload })).statusCode, 400);
  }
  assert.deepEqual(f.calls, []);
  const result = await app.inject({ method: 'POST', url: '/api/translate/start', payload: { naturalLanguage: 'work', workspace: '/explicit' } });
  assert.equal(result.json().sessionId, 'session');
  assert.deepEqual(f.calls[0], ['generate', { naturalLanguage: 'work', workspace: '/explicit' }]);
  assert.deepEqual((await app.inject('/api/translate/session')).json(), { type: 'done' });
  assert.equal((await app.inject('/api/translate/missing')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/translate/session/respond', payload: { type: 'save_path', filePath: '/output' } })).statusCode, 200);
  assert.deepEqual(f.calls[1], ['respond', 'session', { type: 'save', path: '/output' }]);
});

test('HTTP starts only explicit work and persists filters and schedules through injected services', async t => {
  const f = fixture(t), app = await server(t, f);
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs', payload: {} })).statusCode, 400);
  const input = { ittPath: 'lab/demo/demo.itt.impl.json', workdir: path.join(f.home, 'work'), inputs: { value: '1' } };
  const launch = await app.inject({ method: 'POST', url: '/api/runs', payload: input });
  assert.equal(launch.statusCode, 201); assert.deepEqual(launch.json(), { runId: 'new-run' });
  assert.deepEqual(f.calls[0][1], { ...input, suspend: undefined, triggeredBy: 'manual' });
  const filters = await Promise.all(Array.from({ length: 12 }, (_, i) => app.inject({ method: 'POST', url: '/api/filters', payload: { name: `filter-${i}`, conditions: { status: 'completed' } } })));
  assert.ok(filters.every(value => value.statusCode === 201));
  assert.equal((await app.inject('/api/filters')).json().length, 12);
  const id = filters[0].json().id;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/filters/${id}` })).statusCode, 204);
  assert.equal((await app.inject('/api/filters')).json().length, 11);
  const schedule = await app.inject({ method: 'POST', url: '/api/schedules', payload: { ...input, cron: '* * * * *', name: 'timer' } });
  assert.equal(schedule.statusCode, 201, schedule.body); assert.equal(f.timers.size, 1);
  assert.equal(schedule.json().nextRunAt, '2030-01-01T00:00:00.000Z');
  assert.equal(schedule.json().timeZone, 'UTC');
  [...f.timers][0](); await f.options.scheduler.drain();
  assert.equal(f.calls[1][1].triggeredBy, 'schedule');
  const stored = (await app.inject('/api/schedules')).json()[0]; assert.equal(stored.lastRunId, 'new-run');
  assert.equal(stored.lastAttempt.status, 'launched');
  assert.equal(stored.lastAttempt.runId, 'new-run');
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/schedules/${stored.id}`, payload: { lastAttempt: { status: 'failed', startedAt: new Date().toISOString() } } })).statusCode, 400);
  assert.equal((await app.inject('/api/schedules')).json()[0].lastAttempt.status, 'launched');
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/schedules/${stored.id}`, payload: { enabled: false } })).statusCode, 200);
  assert.equal(f.timers.size, 0);
  const disabled = (await app.inject('/api/schedules')).json()[0];
  assert.equal(disabled.nextRunAt, undefined); assert.equal(disabled.timeZone, 'UTC');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/schedules/${stored.id}` })).statusCode, 204);
});

test('run path validation rejects invalid input before launch and allows explicit outside workdirs', async t => {
  const f = fixture(t), app = await server(t, f);
  const input = { ittPath: 'lab/demo/demo.itt.impl.json', workdir: path.join(f.home, 'work') };
  for (const changes of [{ workdir: '../outside' }, { workdir: 'relative' }, { ittPath: '../outside.itt.json' }, { ittPath: 'lab/../../outside.itt.json' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { ...input, ...changes } });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /absolute|within/);
  }
  assert.equal(f.calls.length, 0);
  const explicit = { ittPath: path.join(f.home, 'external.itt.json'), workdir: path.join(os.tmpdir(), 'qa-explicit-workdir') };
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs', payload: explicit })).statusCode, 201);
  assert.deepEqual(f.calls[0][1].workdir, explicit.workdir);
});

test('history resolves entry intent and relative source paths and confines file references', async t => {
  const f = fixture(t), app = await server(t, f);
  f.write('runsDir/lab/run-1/run.json', { run_id: 'run-1', intent: 'lab/demo', entry_intent: 'demo', ittPath: 'lab/demo/demo.itt.impl.json', status: 'running', created_at: '2026-01-01T00:00:00Z' });
  f.write('runsDir/lab/run-1/.snapshot/demo.itt.impl.json', { version: 2, entry: 'END', nodes: {} });
  f.write('brainDir/lab/demo.ts', '// source');
  f.write('runsDir/lab/run-1/output.json', { value: 42 });
  f.write('runsDir/lab/run-1/execution.jsonl', JSON.stringify({ event: 'node_success', node_run_id: 'node-1', outputs: { data: { type: 'file_ref', path: 'output.json' } } }) + '\n');
  assert.equal((await app.inject('/api/runs/run-1')).json().orphaned, true);
  assert.deepEqual((await app.inject('/api/runs/run-1/snapshot')).json(), { version: 2, entry: 'END', nodes: {} });
  assert.deepEqual((await app.inject('/api/runs/run-1/ts-source')).json(), { ts: '// source' });
  assert.deepEqual((await app.inject('/api/runs/run-1/node/node-1/io')).json(), { inputs: null, outputs: { data: { value: 42 } } });
  const external = f.write('outside.json', { secret: 'outside' }), runDir = path.join(f.paths.runsDir, 'lab/run-1');
  fs.symlinkSync(external, path.join(runDir, 'escape.json'));
  for (const name of ['../../../outside.json', 'escape.json', external]) assert.equal(resolveFileRefs({ type: 'file_ref', path: name }, runDir), null);
  f.write('runsDir/lab/run-1/run.json', { run_id: 'run-1', intent: 'demo', ittPath: '../outside/demo.json', status: 'completed' });
  assert.equal((await app.inject('/api/runs/run-1/ts-source')).statusCode, 404);
  f.write('runsDir/corrupt/run.json', 'null');
  assert.equal((await app.inject('/api/stats')).statusCode, 200);
  const history = (await app.inject('/api/runs')).json();
  assert.ok(history.unreadable.some(record => record.path === 'corrupt/run.json' && record.error));
  assert.equal(fs.readFileSync(path.join(f.paths.runsDir, 'corrupt/run.json'), 'utf8'), 'null');
});

test('saved definitions follow frame identities across nested and repeated calls without current-source or basename fallback', async t=>{
  const f=fixture(t),app=await server(t,f),base='runsDir/frames/run-child';
  f.write(`${base}/run.json`,{run_id:'run-child',intent:'entry',status:'suspended'});
  const root={entry:'root',nodes:{root:{id:'root',type:'call'}}},child={entry:'child',nodes:{child:{id:'child',type:'for'}}},nested={entry:'nested',nodes:{nested:{id:'nested',type:'if'}}};
  f.write(`${base}/.snapshot/entry.itt.impl.json`,root);f.write(`${base}/.snapshot/team.child.itt.impl.json`,child);f.write(`${base}/.snapshot/other.child.itt.impl.json`,nested);
  f.write(`${base}/execution.jsonl`,[
    {event:'node_pending',frame_id:'r'},
    {event:'frame_push',frame_id:'c1',callee:'team.child'},
    {event:'frame_push',frame_id:'c2',callee:'other.child'},
    {event:'frame_push',frame_id:'c3',callee:'team.child'},
    {event:'frame_push',frame_id:'missing',callee:'missing.child'},
    {event:'frame_push',frame_id:'escape',callee:'../../outside'},
  ].map(e=>JSON.stringify(e)).join('\n'));
  for(const [frame,expected] of [['r',root],['c1',child],['c2',nested],['c3',child]]) assert.deepEqual((await app.inject(`/api/runs/run-child/snapshot?frameId=${frame}`)).json(),expected);
  f.write(`${base}/.snapshot/child.itt.impl.json`,child);f.write('intentsDir/missing/child/child.itt.impl.json',child);
  for(const frame of ['missing','unknown','escape','../r'])assert.equal((await app.inject(`/api/runs/run-child/snapshot?frameId=${encodeURIComponent(frame)}`)).statusCode,404);
  assert.equal((await app.inject('/api/runs/run-child/snapshot?frameId=')).statusCode,400);
});

test('SPA fallback and explicit extensions do not swallow missing API routes', async t => {
  const f = fixture(t); f.write('public/index.html', '<main>Generic Studio</main>');
  const app = await server(t, f, { publicDir: path.join(f.home, 'public'), capabilities: ['example'], registerExtensions(app) { app.get('/api/example', async () => ({ ok: true })); } });
  assert.equal((await app.inject('/runs/example')).body, '<main>Generic Studio</main>');
  assert.equal((await app.inject('/api/missing')).statusCode, 404);
  assert.deepEqual((await app.inject('/api/example')).json(), { ok: true });
  assert.deepEqual((await app.inject('/api/studio-capabilities')).json().features, ['example']);
});

test('invalid paths fail before resources are touched and extension failures clean up', async t => {
  const f = fixture(t);
  await assert.rejects(createServer({ ...f.options, paths: { ...f.paths, runsDir: './implicit' } }), /explicit absolute/);
  assert.equal(f.closed(), 0); assert.deepEqual(fs.readdirSync(f.home), []);
  await assert.rejects(createServer({ ...f.options, registerExtensions() { throw new Error('extension failed'); } }), /extension failed/);
  assert.equal(f.closed(), 1);
});

test('real HTTP streams replay events, publish live updates and close without hanging shutdown', { timeout: 5000 }, async t => {
  const f = fixture(t), app = await server(t, f);
  f.write('runsDir/run-1/run.json', { run_id: 'run-1', status: 'running' });
  f.write('runsDir/run-1/execution.jsonl', '{"event":"started"}\n');
  f.active.add('run-1');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let stream, request;
  const chunks = [];
  const ended = new Promise((resolve, reject) => {
    request = http.get(`${origin}/api/runs/run-1/events`, response => {
      stream = response; response.setEncoding('utf8');
      response.on('data', chunk => chunks.push(chunk)); response.on('end', resolve); response.on('error', reject);
    }); request.on('error', reject);
  });
  t.after(() => { request.destroy(); stream?.destroy(); });
  for (let i = 0; i < 100 && !chunks.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(chunks.join(''), /started/);
  assert.equal(f.options.broadcaster.hasSubscribers('run-1'), true);
  f.options.broadcaster.publish('run-1', 'data: {"type":"event","event":{"event":"started"}}\n\n');
  f.options.broadcaster.publish('run-1', 'data: {"event":"live"}\n\n');
  await app.close(); await ended;
  assert.equal((chunks.join('').match(/started/g) ?? []).length, 1);
  assert.match(chunks.join(''), /live/); assert.equal(f.options.broadcaster.hasSubscribers('run-1'), false);
  assert.equal(f.closed(), 1);
});

 test('saved filter corruption is reported without replacing the original data', async t => {
  const f = fixture(t), app = await server(t, f);
  f.write('filters.json', '{broken');
  assert.equal((await app.inject('/api/filters')).statusCode, 500);
  assert.equal((await app.inject({ method: 'POST', url: '/api/filters', payload: { name: 'new', conditions: {} } })).statusCode, 500);
  assert.equal(fs.readFileSync(path.join(f.home, 'filters.json'), 'utf8'), '{broken');
});

test('entity HTTP rejects malformed bodies and lossy values without persisting invalid records', async t => {
  const f = fixture(t);
  const { EntityStore } = require('@openhilo/platform-services/entity-store');
  const { EntityService } = require('@openhilo/platform-services/entity-service');
  const store = new EntityStore(path.join(f.home, 'entities.db')); t.after(() => store.close());
  const app = await server(t, f, { entities: new EntityService(store) });
  for (const [method, url] of [['POST', '/api/classes'], ['POST', '/api/entities'], ['PATCH', '/api/entities/missing'], ['PATCH', '/api/entities/missing/tags']]) {
    for (const body of ['null', '[]', '"text"']) assert.equal((await app.inject({ method, url, headers: { 'content-type': 'application/json' }, payload: body })).statusCode, 400, `${url}: ${body}`);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/classes', payload: { name: 'Note' } })).statusCode, 201);
  for (const data of [null, [], 'not a record', 42]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/entities', payload: { className: 'Note', name: 'bad', initData: data } })).statusCode, 400);
  }
  for (const extra of [{ className: {} }, { desc: false }, { tags: [] }, { tags: { tag: 1 } }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/entities', payload: { className: 'Note', name: 'bad', ...extra } })).statusCode, 400);
  }
  const overflow = await app.inject({ method: 'POST', url: '/api/entities', headers: { 'content-type': 'application/json' }, payload: '{"className":"Note","name":"overflow","initData":{"count":1e400}}' });
  assert.equal(overflow.statusCode, 400);
  assert.deepEqual(store.queryEntities('Note'), []);
  const { id } = (await app.inject({ method: 'POST', url: '/api/entities', payload: { className: 'Note', name: 'valid', initData: { count: 1 } } })).json();
  const patch = await app.inject({ method: 'PATCH', url: `/api/entities/${id}`, headers: { 'content-type': 'application/json' }, payload: '{"fields":{"count":2,"bad":1e400}}' });
  assert.equal(patch.statusCode, 400);
  assert.deepEqual(store.getEntity(id).data, { count: 1 });
  assert.equal(store.getEntity(id).version, 1);
});

test('namespace catalogue supports nested modules, dollar exports and source metadata while confining reads', async t => {
  const f = fixture(t), app = await server(t, f);
  f.write('intentsDir/team/numbers/right$/right$.itt.json', { name: 'right$', namespace: 'team.numbers', desc: 'Public module export', sourceFile: 'team/numbers.ts' });
  f.write('intentsDir/team/numbers/right$/right$.itt.impl.json', { sourceFile: 'team/numbers.ts', entry: 'END', nodes: {} });
  f.write('intentsDir/team/numbers/hidden/hidden.itt.json', { public: false });
  f.write('brainDir/team/numbers.ts', '// the original module');
  const external = f.write('outside/secret/secret.itt.json', { desc: 'Must not leak' });
  fs.symlinkSync(path.dirname(path.dirname(external)), path.join(f.paths.intentsDir, 'escape'));
  const index = (await app.inject('/api/namespaces')).json();
  assert.deepEqual(index, [{ namespace: 'team.numbers', entries: ['right$'], intents: ['right$'] }]);
  const detail = await app.inject('/api/namespaces/team.numbers'); assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json().intents, [{ name: 'right$', desc: 'Public module export', hasTs: true, hasImpl: true, isEntry: true }]);
  const itt = await app.inject('/api/namespaces/team.numbers/right%24/itt'); assert.equal(itt.statusCode, 200);
  assert.equal(itt.json().ts, '// the original module');
  assert.equal((await app.inject('/api/namespaces/escape/secret/itt')).statusCode, 404);
  f.write('intentsDir/team/numbers/right$/right$.itt.json', { sourceFile: '../../outside/secret/secret.itt.json' });
  assert.equal((await app.inject('/api/namespaces/team.numbers/right%24/itt')).json().ts, null);
});

test('history JSON resolution preserves prototype-named fields as data', () => {
  const value = JSON.parse('{"__proto__":{"value":1},"nested":{"__proto__":"plain"}}');
  const result = resolveFileRefs(value, os.tmpdir());
  assert.deepEqual(result, value);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.nested), Object.prototype);
});

test('history finds nested module sources and refuses source changed since the run snapshot', async t => {
  const f = fixture(t), app = await server(t, f);
  const source = '// original module';
  const hash = 'sha256:' + require('node:crypto').createHash('sha256').update(source).digest('hex');
  f.write('runsDir/run-module/run.json', { run_id: 'run-module', entry_intent: 'team.numbers.right$', ittPath: 'team/numbers/right$/right$.itt.impl.json', status: 'completed' });
  f.write('runsDir/run-module/.snapshot/team.numbers.right$.itt.impl.json', { sourceFile: 'team/numbers.ts', sourceTs: hash });
  f.write('brainDir/team/numbers.ts', source);
  assert.deepEqual((await app.inject('/api/runs/run-module/ts-source')).json(), { ts: source });
  f.write('brainDir/team/numbers.ts', '// changed after the run');
  assert.equal((await app.inject('/api/runs/run-module/ts-source')).statusCode, 404);
  f.write(`runsDir/run-module/.snapshot/.sources/${hash.slice(7)}.ts`, source);
  assert.deepEqual((await app.inject('/api/runs/run-module/ts-source')).json(), { ts: source });
  f.write(`runsDir/run-module/.snapshot/.sources/${hash.slice(7)}.ts`, '// tampered copy');
  assert.equal((await app.inject('/api/runs/run-module/ts-source')).statusCode, 404);
  f.write('runsDir/run-module/.snapshot/team.numbers.right$.itt.impl.json', { sourceFile: '../../outside.ts' });
  assert.equal((await app.inject('/api/runs/run-module/ts-source')).statusCode, 404);
});

test('entity HTTP lifecycle distinguishes validation, conflicts and missing records with real SQLite', async t => {
  const f = fixture(t);
  const { EntityStore } = require('@openhilo/platform-services/entity-store');
  const { EntityService } = require('@openhilo/platform-services/entity-service');
  const store = new EntityStore(path.join(f.home, 'entities.db')); t.after(() => store.close());
  const app = await server(t, f, { entities: new EntityService(store) });
  const request = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  const definition = { name: 'Note', schema: { title: 'text' }, desc: 'Notes' };
  assert.equal((await request('POST', '/api/classes', definition)).statusCode, 201);
  assert.equal((await request('POST', '/api/classes', definition)).statusCode, 409);
  assert.deepEqual((await app.inject('/api/classes/Note')).json(), { desc: 'Notes', schema: { title: 'text' } });
  assert.equal((await request('POST', '/api/classes', { name: 'Invalid', schema: [] })).statusCode, 400);
  assert.equal((await request('POST', '/api/entities', { className: 'Missing', name: 'entry' })).statusCode, 409);
  const { id } = (await request('POST', '/api/entities', { className: 'Note', name: 'entry', initData: { title: 'Before' } })).json();
  assert.equal((await request('PATCH', `/api/entities/${id}`, { fields: { title: 'After', nested: { values: [true, null, 3] } } })).statusCode, 200);
  const entity = (await app.inject(`/api/entities/${id}`)).json();
  assert.deepEqual(entity.data, { title: 'After', nested: { values: [true, null, 3] } });
  assert.equal((await app.inject('/api/entities?className=Note')).json()[0].id, id);
  assert.equal((await app.inject('/api/entities')).statusCode, 400);
  assert.equal((await request('DELETE', '/api/classes/Note')).statusCode, 409);
  assert.equal((await request('PATCH', `/api/entities/${id}/tags`, { tagName: 'missing', tagValue: 'value' })).statusCode, 400);
  assert.equal((await request('DELETE', `/api/entities/${id}`)).statusCode, 200);
  assert.equal((await request('DELETE', `/api/entities/${id}`)).statusCode, 404);
  assert.equal((await app.inject(`/api/entities/${id}`)).statusCode, 404);
  assert.equal((await request('PATCH', `/api/entities/${id}`, { fields: { title: 'Missing' } })).statusCode, 404);
  assert.equal((await request('DELETE', '/api/classes/Note')).statusCode, 200);
  assert.equal((await request('DELETE', '/api/classes/Note')).statusCode, 404);
  assert.equal((await app.inject('/api/classes/Note')).statusCode, 404);
});

test('run reads expose pending shutdown until the supervisor confirms exit', async t => {
  const f = fixture(t);
  const stopping = { requestedAt: '2026-10-07T16:00:00Z', error: 'Cleanup not confirmed' };
  f.options.workers.stopState = () => stopping;
  f.write('runsDir/run-stop/run.json', { run_id: 'run-stop', intent: 'demo', workdir: '/tmp/qa', status: 'running', created_at: '2026-10-07T15:59:00Z' });
  f.active.add('run-stop');
  const app = await server(t, f);
  assert.deepEqual((await app.inject('/api/runs/run-stop')).json().stopping, stopping);
  assert.deepEqual((await app.inject('/api/runs')).json().runs[0].stopping, stopping);
  f.options.workers.abort = () => 'already_terminal';
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs/run-stop/abort' })).statusCode, 409);
  f.options.workers.abort = () => 'not_found';
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs/run-stop/abort' })).statusCode, 404);
});

test('stopping executions are not offered as available human or AI decisions', async t => {
  const f = fixture(t);
  f.options.workers.stopState = () => ({ requestedAt: new Date().toISOString() });
  f.write('runsDir/run-stop/run.json', { run_id: 'run-stop', intent: 'demo', workdir: '/tmp/qa', status: 'suspended', created_at: '2026-10-07T15:59:00Z' });
  const app = await server(t, f);
  assert.deepEqual((await app.inject('/api/human-todos')).json(), []);
  const human = await app.inject('/api/runs/run-stop/human-node');
  assert.equal(human.statusCode, 409); assert.match(human.json().error, /stopping/);
  f.write('runsDir/run-stop/run.json', { run_id: 'run-stop', status: 'running' });
  f.write('runsDir/run-stop/ai-questions.json', { version: 1, questions: [{ taskId: 'task', attemptId: 'attempt', questionId: 'q', status: 'pending', instruction: 'QA', question: { id: 'q', prompt: 'QA?', answer: 'text' }, askedAt: '2026-10-07', updatedAt: '2026-10-07' }] });
  f.active.add('run-stop');
  const questions = (await app.inject('/api/runs/run-stop/ai-questions')).json();
  assert.equal(questions[0].available, false);
});

test('stop recovery is reconciled before reading terminal detail and list snapshots', async t => {
  const f = fixture(t);
  const record = { run_id: 'run-stop', intent: 'demo', workdir: '/tmp/qa', status: 'failed', created_at: '2026-10-07T15:59:00Z' };
  f.options.workers.refreshStops = () => f.write('runsDir/run-stop/run.json', { ...record, status: 'aborted' });
  const app = await server(t, f);
  for (const url of ['/api/runs/run-stop', '/api/runs']) {
    f.write('runsDir/run-stop/run.json', record);
    const response = (await app.inject(url)).json();
    assert.equal((response.runs?.[0] ?? response).status, 'aborted');
  }
});

test('run API qualifies historical names without rewriting receipts and exposes failed checkpoint retry',async t=>{
 const f=fixture(t),id='failed-run';const base='runsDir/'+id;
 const receipt={run_id:id,intent:'entry',ittPath:'first/entry/entry.itt.impl.json',workdir:'/tmp/fixture',status:'failed',created_at:'2026-10-23T12:00:00Z'};
 f.write(base+'/run.json',receipt);
 f.write(base+'/execution.jsonl',[{event:'node_failed',node_run_id:'failure-1',error:'Invalid field',diagnostics:{stdout:'hello',stderr:'bad value',exitCode:1,rawOutputs:'{"value":"bad"}'}},{event:'run_failed',node_run_id:'failure-1',reason:'Temporary error',failure:{safeToReplay:false}},{event:'suspended_state',global_seq:1,call_stack:[]}].map(JSON.stringify).join('\n')+'\n');
 const app=await server(t,f);
 const detail=(await app.inject('/api/runs/'+id)).json();assert.equal(detail.workflowName,'first.entry');assert.equal(detail.resumeFailure.nodeRunId,'failure-1');
 assert.equal(detail.workerActive,false);
 f.active.add(id);
 const settling=(await app.inject('/api/runs/'+id)).json();assert.equal(settling.workerActive,true);assert.equal(settling.resumeFailure,undefined);
 f.active.delete(id);
 assert.equal((await app.inject('/api/runs')).json().runs[0].workflowName,'first.entry');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home,base,'run.json'))),receipt);
 const io=(await app.inject('/api/runs/'+id+'/node/failure-1/io')).json();assert.equal(io.outputs,null);assert.equal(io.error,'Invalid field');assert.equal(io.diagnostics.stdout,'hello');assert.deepEqual(JSON.parse(io.diagnostics.rawOutputs),{value:'bad'});
 const response=await app.inject({method:'POST',url:'/api/runs/'+id+'/resume',payload:{retryFailedNode:'failure-1'}});
 assert.equal(response.statusCode,200);assert.equal(f.calls.at(-1)[2].retryFailedNode,'failure-1');
});


test('browser cross-origin mutations cannot stop work or change settings', async t => {
  const f = fixture(t), app = await server(t, f);
  f.write('runsDir/owned/run.json', { run_id: 'owned', status: 'running' });
  for (const headers of [
    { host: 'localhost:3000', origin: 'https://untrusted.example' },
    { host: 'localhost:3000', origin: 'http://localhost:3001' },
    { host: 'localhost:3000', origin: 'null' },
    { host: 'localhost:3000', 'sec-fetch-site': 'cross-site' },
    { host: 'localhost:3000', 'sec-fetch-site': 'same-site' },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/runs/owned/abort', headers });
    assert.equal(response.statusCode, 403, JSON.stringify({ headers, body: response.body }));
  }
  assert.equal(f.calls.length, 0, 'no mutating handler may run');
  assert.equal((await app.inject({ method:'PUT', url:'/api/config', headers:{origin:'https://untrusted.example'}, payload:{mode:'changed'} })).statusCode,403);
  assert.deepEqual((await app.inject('/api/config')).json(),{mode:'offline'});
});

test('same-origin browser, native clients and explicit CORS origins retain access', async t => {
  const f = fixture(t), app = await server(t, f, { corsOrigin: ['https://trusted.example'] });
  f.write('runsDir/owned/run.json', { run_id:'owned', status:'running' });
  for (const headers of [
    {}, {host:'localhost:3000', origin:'http://localhost:3000'},
    {host:'[::1]:3000', origin:'http://[::1]:3000'},
    {host:'192.0.2.10:3000', origin:'http://192.0.2.10:3000'},
    {host:'localhost:3000', origin:'https://trusted.example', 'sec-fetch-site':'cross-site'},
  ]) assert.equal((await app.inject({method:'POST',url:'/api/runs/owned/abort',headers})).statusCode,200);
  assert.equal(f.calls.length,5);
  assert.equal((await app.inject({method:'OPTIONS',url:'/api/config',headers:{origin:'https://trusted.example','access-control-request-method':'PUT'}})).statusCode,204);
  assert.equal((await app.inject({method:'POST',url:'/api/runs/owned/abort',headers:{origin:'https://trusted.example.evil.invalid'}})).statusCode,403);
});

test('run API rejects malformed pagination and event tails but preserves explicit full history', async t => {
  const f=fixture(t),app=await server(t,f);
  f.write('runsDir/trace/run.json',{run_id:'trace',intent:'demo',workdir:'/work',status:'completed',created_at:'2026-01-01'});
  f.write('runsDir/trace/execution.jsonl',Array.from({length:205},(_,i)=>JSON.stringify({event:'fixture',i})).join('\n'));
  for(const query of ['page=0','page=-1','page=2junk','page=1.5','limit=0','limit=NaN','limit=1e100','page=9007199254740991&limit=20'])
    assert.equal((await app.inject('/api/runs?'+query)).statusCode,400,query);
  for(const query of ['-1','NaN','3junk','1.5'])assert.equal((await app.inject('/api/runs/trace?tailEvents='+query)).statusCode,400,query);
  assert.equal((await app.inject('/api/runs/trace?tailEvents=0')).json().events.length,205);
  assert.equal((await app.inject('/api/runs/trace')).json().events.length,200);
});


test('unconfigured DNS hosts cannot reach API handlers through rebinding', async t => {
  const f=fixture(t),app=await server(t,f);
  f.write('runsDir/owned/run.json',{run_id:'owned',status:'running'});
  for(const host of ['untrusted.example:3000','localhost.evil.invalid:3000']) {
    assert.equal((await app.inject({url:'/api/config',headers:{host,origin:'http://'+host}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/runs/owned/abort',headers:{host,origin:'http://'+host}})).statusCode,403);
  }
  assert.equal(f.calls.length,0);
  const configured=await server(t,f,{allowedHosts:['studio.example']});
  assert.equal((await configured.inject({method:'POST',url:'/api/runs/owned/abort',headers:{host:'studio.example:3000',origin:'http://studio.example:3000'}})).statusCode,200);
  assert.equal((await configured.inject({url:'/api/config',headers:{host:'studio.example.evil.invalid'}})).statusCode,403);
  assert.equal((await configured.inject({url:'/api/config',headers:{host:'untrusted.example','x-forwarded-host':'localhost'}})).statusCode,403);
});


test('workflow metadata is supplied by the selected application and absent fields stay absent', async t => {
 const f=fixture(t);
 f.write('intentsDir/lab/entry/entry.itt.json',{name:'entry',stage:'draft',tags:{team:'alpha',bad:{nested:true}}});
 f.write('intentsDir/lab/old/old.itt.json',{name:'old'});
 const app=await server(t,f,{application:{version:1,id:'lab',title:'Lab',tags:{},workflowFacet:{field:'stage',label:'Stage',values:[]}}});
 const result=(await app.inject('/api/namespaces/lab')).json();
 assert.equal(result.intents.find(i=>i.name==='entry').facet,'draft');
 assert.deepEqual(result.intents.find(i=>i.name==='entry').tags,{team:'alpha'});
 assert.equal(result.intents.find(i=>i.name==='old').facet,undefined);
 const neutral=await server(t,f);
 assert.equal((await neutral.inject('/api/namespaces/lab')).json().intents.find(i=>i.name==='entry').facet,undefined);
});


test('workflow group navigation filters all namespaces and mixed namespaces without hiding unclassified workflows from All', async t => {
 const f=fixture(t);
 for (const [ns,name,stage] of [['first','draftOnly','draft'],['mixed','draftEntry','draft'],['mixed','readyEntry','ready'],['last','readyOnly','ready'],['legacy','old',undefined]]) {
  f.write(`intentsDir/${ns}/${name}/${name}.itt.json`,{name,...(stage?{stage}:{})});
 }
 const app=await server(t,f,{application:{version:1,id:'lab',title:'Lab',tags:{},workflowFacet:{field:'stage',label:'Stage',values:[{value:'draft',label:'Draft'},{value:'ready',label:'Ready'}]}}});
 const ready=(await app.inject('/api/namespaces?facet=ready')).json();
 assert.deepEqual(ready,[{namespace:'last',entries:['readyOnly'],intents:['readyOnly']},{namespace:'mixed',entries:['readyEntry'],intents:['readyEntry']}]);
 assert.deepEqual((await app.inject('/api/namespaces?facet=draft')).json().map(n=>n.namespace),['first','mixed']);
 assert.equal((await app.inject('/api/namespaces')).json().flatMap(n=>n.intents).length,5);
 assert.deepEqual((await app.inject('/api/namespaces?facet=unknown')).json(),[]);
 assert.equal((await app.inject('/api/namespaces?facet=draft&facet=ready')).statusCode,400);
 const neutral=await server(t,f);
 assert.equal((await neutral.inject('/api/namespaces?facet=ready')).json().flatMap(n=>n.intents).length,5);
});
