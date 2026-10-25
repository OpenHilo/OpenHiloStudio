const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractHumanNodeInfo, extractHumanHistory } = require('@openhilo/platform-services/human-history');
const { listRuns, findRunDir } = require('@openhilo/platform-services/run-history');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-history-'));
  fs.mkdirSync(path.join(root, '.snapshot')); fs.mkdirSync(path.join(root, 'io_records'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = (name, prompt) => fs.writeFileSync(path.join(root, '.snapshot', `${name}.itt.impl.json`), JSON.stringify({ nodes: {
    review: { executor: 'human', intent: prompt, inputsFrom: { value: '$value' }, outputsTo: { answer: 'answer' }, outputs: { answer: 'boolean' } },
  } }));
  const log = events => fs.writeFileSync(path.join(root, 'execution.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  return { root, snapshot, log };
}
const pending = (id, ts, extra = {}) => ({ event: 'node_pending', ts, node_id: 'review', node_run_id: id, executor: 'human', node_type: 'call', ...extra });
const suspended = id => ({ event: 'node_suspended', ts: 2, node_run_id: id });
const state = (intent, value) => ({ event: 'suspended_state', ts: 3, global_seq: 2, call_stack: [{ frame_id: intent, intent_name: intent, current_node: 'review', scope_stack: [{ kind: 'base', vars: { value } }], return_context: null }] });
const success = (id, ts) => ({ event: 'node_success', ts, node_run_id: id, outputs: { answer: true } });

test('pending display requires a valid terminal suspension and uses exact recorded inputs', async t => {
  const f = fixture(t); f.snapshot('root', 'Review');
  const events = [pending('first', 1), suspended('first'), state('root', 3)]; f.log(events);
  fs.writeFileSync(path.join(f.root, 'io_records', 'first_inputs.json'), JSON.stringify({ value: 6, object: { enabled: true } }));
  assert.deepEqual((await extractHumanNodeInfo(f.root, 'display-name', true)).resolvedInputs, { value: '6', object: '{"enabled":true}' });
  fs.appendFileSync(path.join(f.root, 'execution.jsonl'), '{broken-final');
  assert.equal(await extractHumanNodeInfo(f.root, 'root'), null);
  f.log([...events, { event: 'run_resume', ts: 4, current_node: 'review' }]);
  assert.equal(await extractHumanNodeInfo(f.root, 'root'), null);
});

test('loop history preserves separate operations while grouping a suspended operation with its resume attempt', async t => {
  const f = fixture(t); f.snapshot('root', 'Review loop value');
  f.log([
    pending('first', 1, { frame_id: 'root', intent_name: 'root' }), suspended('first'), state('root', 1),
    { event: 'run_resume', ts: 4, current_node: 'review' }, pending('resume-first', 5, { frame_id: 'root', intent_name: 'root' }), success('resume-first', 6),
    pending('second', 7, { frame_id: 'root', intent_name: 'root' }), suspended('second'), state('root', 2),
  ]);
  const history = await extractHumanHistory(f.root, 'display-name');
  assert.equal(history.length, 2); assert.deepEqual(history.map(item => item.status), ['completed', 'suspended']);
  assert.deepEqual(history[0].attemptNodeRunIds, ['first', 'resume-first']);
  assert.equal(history[0].resolvedInputs.value, 1); assert.equal(history[1].resolvedInputs.value, 2);
});

test('legacy nested logs select the child snapshot without merging identical node ids across frames', async t => {
  const f = fixture(t); f.snapshot('root', 'Root prompt'); f.snapshot('child', 'Child prompt');
  f.log([{ event: 'run_start', ts: 0, intent: 'root' }, pending('parent', 1), success('parent', 2),
    { event: 'frame_push', ts: 3, frame_id: 'child-frame', callee: 'child' }, pending('child', 4), suspended('child'), state('child', 'child-input'),
    { event: 'run_resume', ts: 6, current_node: 'review' }, pending('child-resumed', 7), success('child-resumed', 8),
    { event: 'frame_pop', ts: 9, frame_id: 'child' }]);
  const history = await extractHumanHistory(f.root, 'display-name');
  assert.deepEqual(history.map(item => item.prompt), ['Root prompt', 'Child prompt']);
  assert.deepEqual(history[1].attemptNodeRunIds, ['child', 'child-resumed']);
});

test('failed resumed answers are not shown as still pending', async t => {
  const f = fixture(t); f.snapshot('root', 'Review');
  f.log([pending('first', 1), suspended('first'), state('root', 1), { event: 'run_resume', ts: 4 }, pending('resumed', 5),
    { event: 'node_failed', ts: 6, node_run_id: 'resumed', error: 'Invalid answer' }]);
  const history = await extractHumanHistory(f.root, 'root');
  assert.equal(history.length, 1); assert.equal(history[0].status, 'failed'); assert.equal(history[0].error, 'Invalid answer');
  assert.equal(history[0].completedAt, new Date(6000).toISOString());
});

test('snapshot and input record reads cannot follow paths outside their run subdirectories', async t => {
  const f = fixture(t); f.snapshot('root', 'Review');
  fs.writeFileSync(path.join(f.root, 'private.itt.impl.json'), JSON.stringify({ nodes: { review: { executor: 'human', intent: 'Do not read' } } }));
  f.log([state('../private', 1)]); assert.equal(await extractHumanNodeInfo(f.root, 'root'), null);
  fs.symlinkSync(path.join(f.root, 'private.itt.impl.json'), path.join(f.root, '.snapshot', 'escape.itt.impl.json'));
  f.log([state('escape', 1)]); assert.equal(await extractHumanNodeInfo(f.root, 'root'), null);
});

test('run listings retain legacy metadata and skip corrupt/malformed headers', async t => {
  const f = fixture(t), directory = path.join(f.root, 'legacy', 'hash', 'id'); fs.mkdirSync(directory, { recursive: true });
  const record = { run_id: 'old-id', intent: 'display', workdir: '/work', status: 'completed', created_at: '2026-01-01', updated_at: '2026-01-01', custom: { retained: true } };
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(record));
  fs.writeFileSync(path.join(f.root, 'run.json'), '{}');
  assert.deepEqual((await listRuns({ runsDir: f.root })).runs, [record]);
  assert.equal(await findRunDir('old-id', f.root), directory);
});

test('run listings identify unreadable records without rewriting them or hiding healthy history', async t => {
  const f = fixture(t);
  const record = { run_id: 'healthy', intent: 'qa', workdir: '/work', status: 'completed', created_at: '2026-01-01', updated_at: '2026-01-01' };
  const values = { healthy: JSON.stringify(record), broken: '{"run_id":', malformed: JSON.stringify({ ...record, run_id: 'malformed', workdir: null }) };
  for (const [id, raw] of Object.entries(values)) {
    fs.mkdirSync(path.join(f.root, id)); fs.writeFileSync(path.join(f.root, id, 'run.json'), raw);
  }
  const result = await listRuns({ runsDir: f.root });
  assert.equal(result.total, 1); assert.deepEqual(result.runs, [record]);
  assert.deepEqual(result.unreadable.map(item => item.path).sort(), ['broken/run.json', 'malformed/run.json']);
  assert.ok(result.unreadable.every(item => typeof item.error === 'string' && item.error.length > 0));
  const filtered = await listRuns({ runsDir: f.root, filters: { intent: 'different' } });
  assert.equal(filtered.total, 0); assert.equal(filtered.unreadable.length, 2);
  for (const [id, raw] of Object.entries(values)) assert.equal(fs.readFileSync(path.join(f.root, id, 'run.json'), 'utf8'), raw);
});

test('invalid history filters are rejected instead of appearing to match zero runs', async t => {
  const f = fixture(t);
  for (const filters of [{ status: 'invalid-status' }, { createdAfter: 'not-a-date' }, { createdBefore: 'not-a-date' },
    { createdAfter: '2026-10-11T00:00:00Z', createdBefore: '2026-10-10T00:00:00Z' }]) {
    await assert.rejects(listRuns({ runsDir: f.root, filters }), error => error.statusCode === 400 && /filter/i.test(error.message));
  }
  const record = { run_id: 'match', intent: 'qa', workdir: '/work', status: 'completed', created_at: '2026-10-10T15:00:00.000Z' };
  fs.writeFileSync(path.join(f.root, 'run.json'), JSON.stringify(record));
  assert.deepEqual((await listRuns({ runsDir: f.root, filters: { status: 'completed',
    createdAfter: '2026-10-10T10:00:00-04:00', createdBefore: '2026-10-10T12:00:00-04:00' } })).runs, [record]);
  assert.equal((await listRuns({ runsDir: f.root, filters: { status: 'failed' } })).total, 0);
});

for (const graph of [false, true]) test(`checkpoint ${graph ? 'graph' : 'array'} retains pending inputs and resumed history`, async t => {
  const { encodeStateGraph } = require('@openhilo/runtime/state-graph');
  const f = fixture(t); f.snapshot('child', 'Nested review');
  const checkpoint = state('child', { count: 3, enabled: false });
  if (graph) checkpoint.call_stack = encodeStateGraph(checkpoint.call_stack);
  f.log([pending('first', 1), suspended('first'), checkpoint]);
  const info = await extractHumanNodeInfo(f.root, 'root', true);
  assert.equal(info.prompt, 'Nested review');
  assert.deepEqual(info.resolvedInputs, { value: '{"count":3,"enabled":false}' });
  f.log([pending('first', 1), suspended('first'), checkpoint, { event: 'run_resume', ts: 4 }, pending('resumed', 5), success('resumed', 6)]);
  const history = await extractHumanHistory(f.root, 'root');
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'completed');
  assert.deepEqual(history[0].resolvedInputs, { value: { count: 3, enabled: false } });
  assert.deepEqual(history[0].attemptNodeRunIds, ['first', 'resumed']);
});

test('malformed graph checkpoints never advertise a pending human task', async t => {
  const f = fixture(t); f.snapshot('root', 'Review');
  f.log([pending('first', 1), suspended('first'), { ...state('root', 1), call_stack: {
    format: 'openhilo-state-graph', version: 1, root: { ref: 3 }, nodes: [],
  } }]);
  assert.equal(await extractHumanNodeInfo(f.root, 'root', true), null);
});
