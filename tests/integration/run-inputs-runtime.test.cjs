const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { startRun } = require('@openhilo/runtime/run-service');
const { createLocalDeployment } = require('@openhilo/server/local-deployment');
const { createWorkerLaunch } = require('@openhilo/server/worker-launch');
const { execFileSync } = require('node:child_process');
const schema = { flag: { kind: 'boolean' }, count: { kind: 'number' }, data: { kind: 'json' }, text: { kind: 'text' } };
const node = (id, next) => ({ id, type: 'call', executor: 'code', inputsFrom: { payload: 'JSON.stringify({flag, count, data, text})' },
  outputs: {}, outputsTo: {}, script: 'printf "%s\\n" "$payload" >> values.jsonl', next });
const workflow = { version: 2, inputs: schema, entry: 'before', nodes: {
  before: node('before', 'approve'),
  approve: { id: 'approve', type: 'call', executor: 'human', intent: 'Approve', inputsFrom: {}, outputs: { yes: 'boolean' }, outputsTo: { yes: 'yes' }, next: 'after' },
  after: node('after', 'END'),
} };
async function wait(read) {
  for (let n = 0; n < 500; n++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Input fixture worker did not settle');
}

test('HTTP typed input receipt survives real worker execution, human resume, rerun and schedule launch', { timeout: 30000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'typed-run-inputs-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'brain'));
  execFileSync('git', ['init', path.join(home, 'brain')], { stdio: 'pipe' });
  const intents = path.join(home, 'intents/lab/values'); fs.mkdirSync(intents, { recursive: true });
  fs.writeFileSync(path.join(intents, 'values.itt.impl.json'), JSON.stringify(workflow));
  const ticks = new Set(), errors = [];
  const host = await createLocalDeployment({ home, aiExecutor: { id: 'never-called', start() { throw new Error('No AI allowed'); } },
    configuration: { read: () => ({}), update() { throw new Error('Not used'); } },
    launch: createWorkerLaunch({ compositionModule: path.join(__dirname, 'fixtures/input-worker.cjs'), env: { INTENTORCH_INPUT_FIXTURE_HOME: home } }),
    clock: { validate: () => true, schedule(_expression, tick) { ticks.add(tick); return { stop() { ticks.delete(tick); } }; } },
    onBackgroundError: error => errors.push(error),
  });
  const request = async (method, url, payload, status = 200) => {
    const response = await host.app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, status, response.body); return response.json();
  };
  const wire = data => ({ flag: 'true', count: '0', data: JSON.stringify(data), text: '  unchanged  ' });
  const output = workdir => fs.readFileSync(path.join(workdir, 'values.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  try {
    for (const [index, data] of [null, [false, 2, { value: 'nested' }], '{"must":"remain a string"}'].entries()) {
      const input = { ittPath: 'lab/values/values.itt.impl.json', workdir: path.join(home, `work-${index}`), inputs: wire(data), inputEncoding: 'typed-text-v1', suspend: true };
      const { runId } = await request('POST', '/api/runs', input, 201);
      await wait(() => !host.workers.isActive(runId));
      const saved = await request('GET', `/api/runs/${runId}`);
      assert.equal(saved.status, 'suspended'); assert.equal(saved.inputEncoding, input.inputEncoding); assert.deepEqual(saved.inputs, input.inputs);
      const expected = { flag: true, count: 0, data, text: '  unchanged  ' };
      assert.deepEqual(output(input.workdir), [expected]);
      const human = await request('GET', `/api/runs/${runId}/human-node`);
      await request('POST', `/api/runs/${runId}/resume`, { humanNodeRunId: human.nodeRunId, humanOutput: { yes: 'true' } });
      await wait(() => !host.workers.isActive(runId));
      assert.equal((await request('GET', `/api/runs/${runId}`)).status, 'completed');
      assert.deepEqual(output(input.workdir), [expected, expected]);
      const rerun = { ...input, workdir: path.join(home, `rerun-${index}`), inputs: saved.inputs, inputEncoding: saved.inputEncoding };
      const again = await request('POST', '/api/runs', rerun, 201);
      await wait(() => !host.workers.isActive(again.runId));
      assert.deepEqual(output(rerun.workdir), [expected]);
    }
    const before = host.workers.activeRunIds().size;
    for (const patch of [{ inputs: { flag: true } }, { inputs: [] }, { inputs: null }, { inputEncoding: 'future' }]) {
      await request('POST', '/api/runs', { ittPath: 'lab/values/values.itt.impl.json', workdir: path.join(home, 'bad'), inputs: wire(null), ...patch }, 400);
    }
    assert.equal(host.workers.activeRunIds().size, before); assert.equal(fs.existsSync(path.join(home, 'bad')), false);
    const scheduledWork = path.join(home, 'scheduled');
    await request('POST', '/api/schedules', { name: 'Typed schedule', cron: '* * * * *', ittPath: 'lab/values/values.itt.impl.json', workdir: scheduledWork,
      inputs: { ...wire({ scheduled: true }), flag: 'false' }, inputEncoding: 'typed-text-v1' }, 201);
    await host.startSchedules(); for (const tick of ticks) tick(); await host.scheduler.drain();
    const schedule = (await request('GET', '/api/schedules'))[0];
    assert.equal(schedule.inputEncoding, 'typed-text-v1');
    await wait(() => !host.workers.isActive(schedule.lastRunId));
    assert.equal((await request('GET', `/api/runs/${schedule.lastRunId}`)).inputEncoding, 'typed-text-v1');
    assert.deepEqual(output(scheduledWork), [{ flag: false, count: 0, data: { scheduled: true }, text: '  unchanged  ' }]);
    assert.deepEqual(errors, []);
  } finally { await host.close(); }
});

test('invalid typed schema values abort before runtime resource creation or effects', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-input-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entryFile = path.join(root, 'values.itt.impl.json'); fs.writeFileSync(entryFile, JSON.stringify(workflow));
  let resources = 0;
  for (const patch of [{ flag: '1' }, { count: '0x10' }, { data: 'not-json' }, { data: '[1e400]' }, { data: '[-0]' }]) {
    let runDir;
    await assert.rejects(startRun({ intent: 'values', entryFile, workdir: path.join(root, 'work'), runsDir: path.join(root, 'runs'),
      inputs: { flag: 'true', count: '1', data: 'null', text: 'keep', ...patch }, inputEncoding: 'typed-text-v1',
      onRunCreated(_id, dir) { runDir = dir; }, populateSnapshot({ snapshotDir }) { fs.copyFileSync(entryFile, path.join(snapshotDir, 'values.itt.impl.json')); },
      createResources() { resources++; throw new Error('Unexpected resource creation'); },
    }), /Invalid (boolean|number|json) run input/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'))).status, 'aborted');
  }
  assert.equal(resources, 0); assert.equal(fs.existsSync(path.join(root, 'work/values.jsonl')), false);
});


test('composition receipts cannot mislabel the runtime input encoding', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-input-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(startRun({ intent: 'values', entryFile: 'unused', workdir: path.join(root, 'work'), runsDir: path.join(root, 'runs'),
    inputs: {}, receipt: { inputEncoding: 'typed-text-v1' },
    populateSnapshot() { throw new Error('Unexpected snapshot'); },
    createResources() { throw new Error('Unexpected resource creation'); },
  }), /runtime-owned keys/);
  assert.deepEqual(fs.readdirSync(root), []);
});
