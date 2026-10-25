const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createWorkerLaunch } = require('@openhilo/server/worker-launch');
const { createServer } = require('@openhilo/server');
const { WorkerSupervisor } = require('@openhilo/platform-services/worker-supervisor');
const { WorkerSystemHost } = require('@openhilo/platform-services/worker-system-host');
const { Broadcaster } = require('@openhilo/platform-services/broadcaster');
const { FilterService } = require('@openhilo/platform-services/filter-service');
const { ScheduleService } = require('@openhilo/platform-services/schedule-service');
const { Scheduler } = require('@openhilo/platform-services/scheduler');
const resolved = name => JSON.stringify(require.resolve(name));

async function setup(t, { closeFails = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-packaged-worker-'));
  const paths = { runsDir: path.join(home, 'runs'), intentsDir: path.join(home, 'intents'), brainDir: path.join(home, 'brain'), workspacesDir: path.join(home, 'workspaces') };
  const dir = path.join(paths.intentsDir, 'lab', 'approval'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'approval.itt.impl.json'), JSON.stringify({ version: 2, entry: 'create', nodes: {
    create: { id: 'create', type: 'call', executor: 'sys', callee: 'createEntity', inputsFrom: { className: '"Document"', name: '"one"', initData: '({})', desc: '"fixture"', tags: '({})' }, outputsTo: {}, outputs: {}, next: 'query' },
    query: { id: 'query', type: 'call', executor: 'sys', callee: 'queryClasses', inputsFrom: {}, outputsTo: { result: 'classes' }, outputs: { result: 'json' }, next: 'ai' },
    ai: { id: 'ai', type: 'call', executor: 'ai', intent: 'Ask before preparing', inputsFrom: { classes: '$classes' }, outputsTo: { name: 'name' }, outputs: { name: 'text' }, next: 'review' },
    review: { id: 'review', type: 'call', executor: 'human', intent: 'Approve', inputsFrom: { name: '$name' }, outputsTo: { approved: 'approved' }, outputs: { approved: 'boolean' }, next: 'effect' },
    effect: { id: 'effect', type: 'call', executor: 'code', lang: 'bash', script: 'printf completed >> effect.txt', inputsFrom: {}, outputsTo: {}, outputs: {}, next: 'END' },
  } }));
  const guard = path.join(home, 'guard.cjs');
  fs.writeFileSync(guard, `const Module = require('node:module'), load = Module._load; Module._load = function(name, ...args) {
    if (/ai-claude|ai-sdk|@intentorch|anthropic|openai|node-pty/.test(name)) throw new Error('Forbidden live dependency: ' + name);
    return load.call(this, name, ...args);
  }; globalThis.fetch = () => { throw new Error('Outbound network forbidden'); };`);
  const compositionModule = path.join(home, 'composition.cjs');
  fs.writeFileSync(compositionModule, `
    const fs = require('node:fs'), path = require('node:path');
    const { createDispatcher } = require(${resolved('@openhilo/runtime/dispatcher')});
    const { createCodeExecutor } = require(${resolved('@openhilo/code-local')});
    const { createTaskExecution } = require(${resolved('@openhilo/ai-contracts')});
    const { Snapshotter } = require(${resolved('@openhilo/platform-services/brain-snapshot')});
    exports.createComposition = request => {
      if (request.kind === 'resume-worker') {
        const saved = JSON.parse(fs.readFileSync(path.join(request.input.runDir, 'run.json')));
        if (saved.application?.id !== 'fixture.generic') throw new Error('Wrong saved application');
      }
      return {
        runsDir: ${JSON.stringify(paths.runsDir)}, intentsDir: ${JSON.stringify(paths.intentsDir)},
        receipt: { application: { id: 'fixture.generic', version: 1 } },
        populateSnapshot(context) { new Snapshotter({ ittHome: ${JSON.stringify(home)}, entryFile: path.join(${JSON.stringify(paths.intentsDir)}, request.input.ittPath), snapshotDir: context.snapshotDir }).collect(); },
        createResources(context, ports) {
          const aiExecutor = { id: 'fixture.ai', capabilities: ['structured_output', 'workspace', 'questions'],
            async start(task, host) { return createTaskExecution(task, host, async execution => {
              if (task.inputs.classes[0].name !== 'Document') throw new Error('System result missing');
              const name = await execution.ask({ id: 'name', prompt: 'Report name?', answer: 'text' });
              fs.appendFileSync(path.join(context.workdir, 'ai-effects.txt'), name + '\\n');
              return { status: 'completed', outputs: { name }, artifacts: [] };
            }); }
          };
          return { executor: createDispatcher({ ...ports, aiExecutor, runId: context.runId, workdir: context.workdir, codeExecutor: createCodeExecutor(context.workdir),
            sysExecutor: async (node, inputs) => {
              if (node.callee === 'createEntity') await require('node:assert/strict').rejects(ports.systemExecutor(node, inputs, { caller: 'ai' }), /Permission denied/);
              return ports.systemExecutor(node, inputs, { caller: 'executor_sys', runId: context.runId, testContext: 'fixture' });
            },
          }) };
        },
        close() { fs.appendFileSync(${JSON.stringify(path.join(home, 'closed.txt'))}, 'closed\\n'); if (${JSON.stringify(closeFails)}) throw new Error('Cleanup failed'); },
      };
    };
  `);
  const children = [], exits = [], errors = [], messages = [];
  const broadcaster = new Broadcaster();
  const schedules = new ScheduleService(path.join(home, 'schedules.json'), { validateCron: () => true });
  const host = new WorkerSystemHost({ entityManager: { queryClasses: () => [{ name: 'Document', desc: 'test', tags: {} }], createEntity() { fs.appendFileSync(path.join(home, 'system-effects.txt'), 'created\n'); return { id: 'entity', created: true }; } }, scheduleService: schedules, intentsDir: paths.intentsDir, workspacesDir: paths.workspacesDir });
  const supervisor = new WorkerSupervisor({ broadcaster, launch: createWorkerLaunch({ compositionModule, env: { NODE_OPTIONS: `--require=${guard}` } }),
    handleSystemCall: (worker, message) => host.handleSystemCall(worker, message),
    fork(file, args, options) {
      assert.equal(path.basename(file), 'worker-entry.js'); assert.deepEqual(options.execArgv, []);
      const child = fork(file, args, { ...options, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child); exits.push(once(child, 'exit')); child.stderr.on('data', value => errors.push(value.toString()));
      child.on('message', value => messages.push(value)); return child;
    },
  });
  const workers = Object.assign(supervisor, { queryIntents: () => host.queryIntents(), queryIntentInfo: name => host.queryIntentInfo(name), scheduleService: schedules });
  const scheduler = new Scheduler({ repository: schedules, clock: { validate: () => true, schedule: () => ({ stop() {} }) }, launch: options => workers.forkRun(options) });
  const app = await createServer({ paths, workers, broadcaster, schedules, scheduler, filters: new FilterService(path.join(home, 'filters.json')),
    entities: { listClasses: () => [], getTagDefinitions: () => [] }, configuration: { read: () => ({}), update: () => ({}) },
    generation: { start: async () => { throw new Error('Not used in this workflow fixture'); }, respond: async () => {}, read: async () => undefined },
  });
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(); await Promise.all(exits); await app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  async function waitFor(read, predicate) {
    for (let i = 0; i < 300; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Timed out: ' + errors.join('') + JSON.stringify(messages.at(-1)));
  }
  return { home, paths, app, workers, children, exits, errors, messages, waitFor };
}

test('installed worker preserves HTTP → system IPC → AI answer → human resume → local code and live events', { timeout: 15000 }, async t => {
  const f = await setup(t);
  const workdir = path.join(f.home, 'work');
  const started = await f.app.inject({ method: 'POST', url: '/api/runs', payload: { ittPath: 'lab/approval/approval.itt.impl.json', workdir, inputs: {}, suspend: true } });
  assert.equal(started.statusCode, 201, started.body); const { runId } = started.json();
  const question = (await f.waitFor(async () => (await f.app.inject(`/api/runs/${runId}/ai-questions`)).json(), items => Array.isArray(items) && items.length))[0];
  assert.equal(question.available, true);
  assert.ok(f.messages.some(message => message.type === 'event' && message.event.event === 'node_success'), 'system completion must be live while the AI is still waiting');
  const key = { taskId: question.taskId, attemptId: question.attemptId, questionId: question.questionId };
  const answer = await f.app.inject({ method: 'POST', url: `/api/runs/${runId}/ai-questions/answer`, payload: { key, value: 'Report' } });
  assert.equal(answer.statusCode, 200, answer.body);
  await f.exits[0];
  const prompt = (await f.app.inject(`/api/runs/${runId}/human-node`)).json();
  assert.deepEqual(prompt.outputs, [{ name: 'approved', kind: 'boolean' }]);
  assert.equal(fs.readFileSync(path.join(f.home, 'closed.txt'), 'utf8'), 'closed\n');
  const bad = await f.app.inject({ method: 'POST', url: `/api/runs/${runId}/resume`, payload: { humanOutput: { approved: 'invalid' }, humanNodeRunId: prompt.nodeRunId } });
  assert.equal(bad.statusCode, 400); assert.equal(f.children.length, 1);
  const resumed = await f.app.inject({ method: 'POST', url: `/api/runs/${runId}/resume`, payload: { humanOutput: { approved: 'true' }, humanNodeRunId: prompt.nodeRunId } });
  assert.equal(resumed.statusCode, 200, resumed.body); await f.exits[1];
  assert.equal((await f.app.inject(`/api/runs/${runId}`)).json().status, 'completed');
  assert.equal(fs.readFileSync(path.join(workdir, 'effect.txt'), 'utf8'), 'completed');
  assert.equal(fs.readFileSync(path.join(workdir, 'ai-effects.txt'), 'utf8'), 'Report\n', 'resume must not repeat AI effects');
  assert.equal(fs.readFileSync(path.join(f.home, 'system-effects.txt'), 'utf8'), 'created\n', 'resume must not repeat system writes');
  assert.equal(fs.readFileSync(path.join(f.home, 'closed.txt'), 'utf8'), 'closed\nclosed\n');
  assert.equal(f.errors.join(''), '');
  assert.equal(f.messages.filter(message => message.type === 'done').length, 2);
  assert.equal(f.workers.isActive(runId), false);
});

test('Studio worker waits for explicit zero-output completion and retries do not repeat effects', { timeout: 15000 }, async t => {
  const f = await setup(t);
  const entry = path.join(f.paths.intentsDir, 'lab', 'approval', 'approval.itt.impl.json');
  fs.writeFileSync(entry, JSON.stringify({ version: 2, entry: 'review', nodes: {
    review: { id: 'review', type: 'call', executor: 'human', intent: 'Complete this operation', inputsFrom: {}, outputsTo: {}, outputs: {}, next: 'effect' },
    effect: { id: 'effect', type: 'call', executor: 'code', lang: 'bash', script: 'printf completed >> effect.txt', inputsFrom: {}, outputsTo: {}, outputs: {}, next: 'END' },
  } }));
  for (const attempt of ['first', 'second']) {
    const workdir = path.join(f.home, attempt), firstChild = f.children.length;
    const started = await f.app.inject({ method: 'POST', url: '/api/runs', payload: { ittPath: 'lab/approval/approval.itt.impl.json', workdir, inputs: {} } });
    assert.equal(started.statusCode, 201, started.body); const { runId } = started.json();
    await f.exits[firstChild];
    assert.equal((await f.app.inject(`/api/runs/${runId}`)).json().status, 'suspended');
    assert.equal(fs.existsSync(path.join(workdir, 'effect.txt')), false);
    const prompt = (await f.app.inject(`/api/runs/${runId}/human-node`)).json();
    assert.ok(prompt.taskId); assert.deepEqual(prompt.outputs, []);
    const payload = { humanSubmission: { taskId: prompt.taskId, submissionId: randomUUID(), outputs: {} } };
    const resumed = await f.app.inject({ method: 'POST', url: `/api/runs/${runId}/human-node`, payload });
    assert.equal(resumed.statusCode, 200, resumed.body); assert.equal(resumed.json().status, 'accepted');
    await f.exits[firstChild + 1];
    assert.equal((await f.app.inject(`/api/runs/${runId}`)).json().status, 'completed');
    assert.equal(fs.readFileSync(path.join(workdir, 'effect.txt'), 'utf8'), 'completed');
    const duplicate = await f.app.inject({ method: 'POST', url: `/api/runs/${runId}/human-node`, payload });
    assert.equal(duplicate.statusCode, 200, duplicate.body); assert.equal(duplicate.json().status, 'duplicate');
    assert.equal(f.children.length, firstChild + 2);
    const history = (await f.app.inject(`/api/runs/${runId}/human-history`)).json();
    assert.equal(history.length, 1); assert.equal(history[0].taskId, prompt.taskId);
  }
  assert.equal(f.errors.join(''), '');
});

test('packaged worker cancels unanswered AI work on parent disconnect', { timeout: 15000 }, async t => {
  const f = await setup(t), workdir = path.join(f.home, 'work');
  const response = await f.app.inject({ method: 'POST', url: '/api/runs', payload: { ittPath: 'lab/approval/approval.itt.impl.json', workdir, inputs: {} } });
  const { runId } = response.json();
  await f.waitFor(async () => (await f.app.inject(`/api/runs/${runId}/ai-questions`)).json(), values => Array.isArray(values) && values.length);
  f.children[0].disconnect(); await f.exits[0];
  assert.equal(fs.existsSync(path.join(workdir, 'ai-effects.txt')), false);
  assert.equal(fs.existsSync(path.join(workdir, 'effect.txt')), false);
  assert.equal((await f.app.inject(`/api/runs/${runId}/ai-questions`)).json()[0].status, 'closed');
  assert.equal(fs.readFileSync(path.join(f.home, 'closed.txt'), 'utf8'), 'closed\n');
});

test('worker startup failure closes composition resources without announcing a run', { timeout: 15000 }, async t => {
  const f = await setup(t);
  const result = await f.app.inject({ method: 'POST', url: '/api/runs', payload: { ittPath: 'missing.itt.impl.json', workdir: path.join(f.home, 'work'), inputs: {} } });
  assert.equal(result.statusCode, 500); await f.exits[0];
  assert.equal(fs.readFileSync(path.join(f.home, 'closed.txt'), 'utf8'), 'closed\n');
  assert.equal(f.messages.some(value => value.type === 'started' || value.type === 'done'), false);
  assert.equal(fs.existsSync(f.paths.runsDir), false);
});

test('cleanup failure is reported before a terminal done receipt', { timeout: 15000 }, async t => {
  const f = await setup(t, { closeFails: true }), workdir = path.join(f.home, 'work');
  const response = await f.app.inject({ method: 'POST', url: '/api/runs', payload: { ittPath: 'lab/approval/approval.itt.impl.json', workdir, inputs: {} } });
  const { runId } = response.json();
  const question = (await f.waitFor(async () => (await f.app.inject(`/api/runs/${runId}/ai-questions`)).json(), items => Array.isArray(items) && items.length))[0];
  await f.app.inject({ method: 'POST', url: `/api/runs/${runId}/ai-questions/answer`, payload: { key: { taskId: question.taskId, attemptId: question.attemptId, questionId: question.questionId }, value: 'test' } });
  await f.exits[0];
  assert.equal(f.messages.some(message => message.type === 'done'), false);
  assert.match(f.messages.find(message => message.type === 'error').message, /Cleanup failed/);
  assert.equal(fs.readFileSync(path.join(f.home, 'closed.txt'), 'utf8'), 'closed\n');
});

for (const stop of ['abort', 'disconnect', 'persisted-stop']) test(`worker does not start the next code effect after ${stop}`, { timeout: 15000 }, async t => {
  const f = await setup(t), workdir = path.join(f.home, 'work');
  const entry = path.join(f.paths.intentsDir, 'lab', 'approval', 'approval.itt.impl.json');
  fs.writeFileSync(entry, JSON.stringify({ version: 2, entry: 'inflight', nodes: {
    inflight: { id: 'inflight', type: 'call', executor: 'code',
      script: 'printf started > started.txt\nwhile [ ! -f release.txt ]; do sleep 0.01; done\nprintf settled > settled.txt',
      inputsFrom: {}, outputsTo: {}, outputs: {}, next: 'next' },
    next: { id: 'next', type: 'call', executor: 'code', script: 'printf unexpected > next.txt',
      inputsFrom: {}, outputsTo: {}, outputs: {}, next: 'END' },
  } }));
  const response = await f.app.inject({ method: 'POST', url: '/api/runs', payload: { ittPath: 'lab/approval/approval.itt.impl.json', workdir, inputs: {} } });
  assert.equal(response.statusCode, 201, response.body); const { runId } = response.json();
  try {
    await f.waitFor(() => fs.existsSync(path.join(workdir, 'started.txt')), Boolean);
    if (stop === 'abort') {
      const stopped = await f.app.inject({ method: 'POST', url: `/api/runs/${runId}/abort` });
      assert.equal(stopped.statusCode, 200, stopped.body);
      assert.ok(f.workers.stopState(runId));
      assert.equal(f.children[0].exitCode, null, 'an in-flight code effect is still owned by its worker');
    } else if (stop === 'disconnect') f.children[0].disconnect();
    else {
      const started = f.messages.find(message => message.type === 'started' && message.runId === runId);
      fs.writeFileSync(path.join(started.runDir, 'stop-request.json'), JSON.stringify({ runId, requestedAt: new Date().toISOString(), workerPid: f.children[0].pid }));
    }
    if (stop !== 'persisted-stop') await f.waitFor(() => f.children[0].connected, connected => !connected);
  } finally { fs.writeFileSync(path.join(workdir, 'release.txt'), 'release'); }
  await f.exits[0];
  assert.equal(fs.readFileSync(path.join(workdir, 'settled.txt'), 'utf8'), 'settled');
  assert.equal(fs.existsSync(path.join(workdir, 'next.txt')), false, 'no new code effect after the stop boundary');
  const run = (await f.app.inject(`/api/runs/${runId}`)).json();
  assert.notEqual(run.status, 'completed');
  if (stop === 'abort') assert.equal(run.status, 'aborted');
  assert.equal(f.workers.isActive(runId), false);
});
