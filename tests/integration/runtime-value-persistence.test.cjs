const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileProgram } = require('@openhilo/compiler');
const { startRun, resumeRun } = require('@openhilo/runtime/run-service');

function fixture(t, workflow) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-values-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entryFile = path.join(root, 'main.itt.impl.json'); fs.writeFileSync(entryFile, JSON.stringify(workflow));
  return { intent: 'main', entryFile, workdir: path.join(root, 'workspace'), runsDir: path.join(root, 'runs'), inputs: {},
    populateSnapshot({ snapshotDir }) { fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile))); } };
}
const call = (id, next, inputsFrom = {}, outputsTo = {}) => ({ id, type: 'call', executor: 'sys', callee: 'fixture', inputsFrom, outputsTo, outputs: Object.fromEntries(Object.keys(outputsTo).map(key => [key, 'json'])), next });
const events = result => fs.readFileSync(path.join(result.runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('statically unsupported persistent values fail compilation before any execution', async t => {
  for (const expression of ['Infinity', 'NaN', 'undefined', '-0', '({ nested: undefined })', '[1,,3]', '(() => 1)']) {
    const compiled = compileProgram({ files: { 'main.ts': `export async function main(): Promise<{value: object}> { return {value: ${expression}}; }` },
      entries: [{ file: 'main.ts', exportName: 'main' }] });
    assert.equal(compiled.ok, false, expression);
    assert.ok(compiled.diagnostics.length > 0, expression);
  }
});

test('non-JSON executor inputs are refused before effects and invalid outputs are not retried or followed', async t => {
  for (const badOutput of [false, true]) {
    const workflow = { version: 2, entry: 'first', nodes: {
      first: call('first', 'later', badOutput ? {} : { n: 'Infinity' }, badOutput ? { n: 'n' } : {}),
      later: call('later', 'END'),
    } };
    let calls = 0, closed = 0;
    const result = await startRun({ ...fixture(t, workflow), createResources: () => ({
      executor: async () => { calls++; return { outputs: { n: { missing: undefined } } }; }, close() { closed++; },
    }) });
    assert.equal(result.status, 'aborted'); assert.equal(calls, badOutput ? 1 : 0); assert.equal(closed, 1);
    assert.equal(events(result).some(event => event.event === 'node_success'), false);
  }
});

test('valid nested values survive human suspension and malformed saved numbers fail before resume effects', async t => {
  const workflow = { version: 2, entry: 'assign', outputs: { result: 'data' }, nodes: {
    assign: { id: 'assign', type: 'assign', assignments: [{ var: 'data', type: 'json', expr: '({list:[1,{value:null}], ref:{type:"file_ref",path:"f",hash:"sha256:abc",mtime:1}})' }], next: 'approve' },
    approve: { id: 'approve', type: 'call', executor: 'human', intent: 'Approve', inputsFrom: {}, outputs: { yes: 'boolean' }, outputsTo: { yes: 'yes' }, next: 'effect' },
    effect: call('effect', 'END', { data: '$data' }),
  } };
  let calls = 0, resources = 0;
  const createResources = () => { resources++; return { executor: async (_node, inputs) => {
    calls++; assert.deepEqual(inputs.data.list, [1, { value: null }]); return { outputs: {} };
  } }; };
  const suspended = await startRun({ ...fixture(t, workflow), createResources, humanMode: 'suspend' });
  assert.equal(suspended.status, 'suspended'); assert.equal(calls, 0);
  const logPath = path.join(suspended.runDir, 'execution.jsonl'), saved = fs.readFileSync(logPath, 'utf8');
  const lines = saved.trimEnd().split('\n');
  // Overflow is valid JSON syntax but JSON.parse produces Infinity. Preserve the
  // actual final human frame while corrupting only its retained workflow value.
  lines[lines.length - 1] = lines.at(-1).replace('["value",null]', '["value",1e400]');
  assert.notEqual(lines.at(-1), saved.trimEnd().split('\n').at(-1), 'corruption must alter the graph fixture');
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  const corrupt = fs.readFileSync(logPath), receipt = fs.readFileSync(path.join(suspended.runDir, 'run.json'));
  await assert.rejects(resumeRun({ runDir: suspended.runDir, humanOutput: { yes: 'true' }, createResources }), /JSON-compatible|finite|state graph/i);
  assert.equal(resources, 1); assert.equal(calls, 0);
  assert.deepEqual(fs.readFileSync(logPath), corrupt);
  assert.deepEqual(fs.readFileSync(path.join(suspended.runDir, 'run.json')), receipt);
  fs.writeFileSync(logPath, saved);
  fs.rmSync(path.join(suspended.runDir, 'run.lock'), { force: true });
  const completed = await resumeRun({ runDir: suspended.runDir, humanOutput: { yes: 'true' }, createResources });
  assert.equal(completed.status, 'completed'); assert.equal(calls, 1);
  assert.deepEqual(events(completed).at(-1).outputs.result.list, [1, { value: null }]);
});
