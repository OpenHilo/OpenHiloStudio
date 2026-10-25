// Integration fixture: install @openhilo/runtime alongside platform-services to run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRun, resumeRun } = require('@openhilo/runtime/run-service');
const { extractHumanHistory, extractHumanNodeInfo } = require('@openhilo/platform-services/human-history');

test('actual runtime loop suspension/resume retains each human operation, its typed inputs and attempts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-runtime-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entryFile = path.join(root, 'review.itt.impl.json');
  fs.writeFileSync(entryFile, JSON.stringify({ version: 2, entry: 'each', nodes: {
    each: { id: 'each', type: 'foreach', array_expr: '[1, 2]', item_var: 'item', next_body: 'review', next_exit: 'END' },
    review: { id: 'review', type: 'call', executor: 'human', intent: 'Review this item', inputsFrom: { value: '$item' }, outputsTo: { answer: 'answer' }, outputs: { answer: 'boolean' }, next: 'each' },
  } }));
  const createResources = () => ({ executor: async () => { throw new Error('This workflow must not invoke external executors'); } });
  const started = await startRun({ intent: 'display/name', entryFile, workdir: path.join(root, 'work'), runsDir: path.join(root, 'runs'), inputs: {}, humanMode: 'suspend', createResources,
    populateSnapshot: ({ snapshotDir }) => fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile))),
  });
  assert.equal(started.status, 'suspended');
  let info = await extractHumanNodeInfo(started.runDir, 'display/name', true);
  assert.equal(info.prompt, 'Review this item'); assert.deepEqual(info.resolvedInputs, { value: '1' });
  // Simulate exit of the original temporary test worker; never touch production locks.
  fs.rmSync(path.join(started.runDir, 'run.lock'), { force: true });
  const second = await resumeRun({ runDir: started.runDir, humanOutput: { answer: 'true' }, createResources });
  assert.equal(second.status, 'suspended');
  info = await extractHumanNodeInfo(started.runDir, 'display/name', true); assert.deepEqual(info.resolvedInputs, { value: '2' });
  let history = await extractHumanHistory(started.runDir, 'display/name');
  assert.equal(history.length, 2); assert.deepEqual(history.map(item => item.status), ['completed', 'suspended']);
  assert.deepEqual(history.map(item => item.resolvedInputs.value), [1, 2]);
  fs.rmSync(path.join(started.runDir, 'run.lock'), { force: true });
  const completed = await resumeRun({ runDir: started.runDir, humanOutput: { answer: 'false' }, createResources });
  assert.equal(completed.status, 'completed'); assert.equal(await extractHumanNodeInfo(started.runDir, 'display/name'), null);
  history = await extractHumanHistory(started.runDir, 'display/name');
  assert.equal(history.length, 2); assert.deepEqual(history.map(item => item.status), ['completed', 'completed']);
  assert.deepEqual(history.map(item => item.result.answer), [true, false]);
  assert.ok(history.every(item => item.attemptNodeRunIds.length === 2));
  const logs = fs.readFileSync(path.join(started.runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(logs.filter(event => event.event === 'node_pending').every(event => event.frame_id && event.intent_name === 'review'));
});
