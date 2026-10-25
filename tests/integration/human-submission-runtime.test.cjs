const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRun, resumeRun } = require('@openhilo/runtime/run-service');
const { extractHumanNodeInfo } = require('@openhilo/platform-services/human-history');
const { validateHumanSubmission } = require('@openhilo/platform-services/human-submission');

test('invalid and stale human answers preserve the suspended run; a valid correction resumes without replay', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-submission-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entryFile = path.join(root, 'review.itt.impl.json');
  fs.writeFileSync(entryFile, JSON.stringify({ version: 2, entry: 'before', nodes: {
    before: { id: 'before', type: 'call', executor: 'sys', callee: 'before', inputsFrom: {}, outputsTo: {}, next: 'review' },
    review: { id: 'review', type: 'call', executor: 'human', intent: 'Enter values', inputsFrom: {},
      outputsTo: { number: 'n', flag: 'b', data: 'j', text: 't' }, outputs: { number: 'number', flag: 'boolean', data: 'json', text: 'text' }, next: 'after' },
    after: { id: 'after', type: 'call', executor: 'sys', callee: 'after', inputsFrom: { number: '$n', flag: '$b', data: '$j', text: '$t' }, outputsTo: {}, next: 'END' },
  } }));
  let before = 0, resources = 0, received;
  const createResources = () => { resources++; return { executor: async (node, inputs) => {
    if (node.id === 'before') before++; else received = inputs;
    return { outputs: {} };
  } }; };
  const started = await startRun({ intent: 'review', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {}, humanMode: 'suspend', createResources,
    populateSnapshot: ({ snapshotDir }) => fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile))) });
  assert.equal(started.status, 'suspended');
  const pending = await extractHumanNodeInfo(started.runDir, 'review', true);
  const files = ['run.json', 'execution.jsonl'];
  const saved = files.map(file => fs.readFileSync(path.join(started.runDir, file), 'utf8'));
  const valid = { number: '12.5', flag: 'true', data: '{"items":[1,2]}', text: '' };
  const invalid = [ { ...valid, number: '12abc' }, { ...valid, number: 'Infinity' }, { ...valid, flag: 'yes' },
    { ...valid, data: '{"n":1e999}' }, { number: '2' }, { ...valid, extra: 'oops' } ];
  for (const humanOutput of invalid) {
    assert.throws(() => validateHumanSubmission(started.runDir, humanOutput, pending.nodeRunId), { statusCode: 400 });
    await assert.rejects(resumeRun({ runDir: started.runDir, humanOutput, humanNodeRunId: pending.nodeRunId, createResources }), /human output|Invalid/);
    assert.deepEqual(files.map(file => fs.readFileSync(path.join(started.runDir, file), 'utf8')), saved);
  }
  assert.throws(() => validateHumanSubmission(started.runDir, valid, 'old-operation'), { statusCode: 409 });
  await assert.rejects(resumeRun({ runDir: started.runDir, humanOutput: valid, humanNodeRunId: 'old-operation', createResources }), /no longer current/);
  assert.equal(before, 1); assert.equal(resources, 1); assert.equal(received, undefined);
  const snapshot = path.join(started.runDir, '.snapshot', path.basename(entryFile));
  const originalSnapshot = fs.readFileSync(snapshot);
  fs.unlinkSync(snapshot); fs.symlinkSync(entryFile, snapshot);
  await assert.rejects(resumeRun({ runDir: started.runDir, humanOutput: valid, createResources }), /snapshot resolves outside/);
  assert.throws(() => validateHumanSubmission(started.runDir, valid, pending.nodeRunId), { statusCode: 409 });
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(started.runDir, file), 'utf8')), saved);
  fs.unlinkSync(snapshot); fs.writeFileSync(snapshot, originalSnapshot);
  validateHumanSubmission(started.runDir, valid, pending.nodeRunId);
  fs.rmSync(path.join(started.runDir, 'run.lock'), { force: true });
  const completed = await resumeRun({ runDir: started.runDir, humanOutput: valid, humanNodeRunId: pending.nodeRunId, createResources });
  assert.equal(completed.status, 'completed'); assert.equal(before, 1);
  assert.deepEqual(received, { number: 12.5, flag: true, data: { items: [1, 2] }, text: '' });
});
