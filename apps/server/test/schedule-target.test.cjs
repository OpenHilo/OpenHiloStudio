const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateLocalSchedule } = require(path.join(path.dirname(require.resolve('@openhilo/server')), 'validate-local-schedule.js'));
const { ScheduleValidationError } = require('@openhilo/platform-services/schedule-service');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-target-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ittPath = path.join(root, 'example.itt.impl.json');
  const workflow = { version: 2, entry: 'done', nodes: { done: { id: 'done', type: 'assign', assignments: [], next: 'END' } }, inputs: { count: { kind: 'number' }, enabled: { kind: 'boolean' }, label: { kind: 'text' } } };
  fs.writeFileSync(ittPath, JSON.stringify(workflow));
  return { root, workflow, schedule: { id: 'qa', name: 'qa', cron: '* * * * *', enabled: true, ittPath, workdir: path.join(root, 'not-created'), inputs: { count: '0', enabled: 'false', label: '' }, inputEncoding: 'typed-text-v1' } };
}
test('local preflight accepts zero, false and empty text without creating a workspace', t => {
  const f = fixture(t); validateLocalSchedule(f.schedule, f.root); assert.equal(fs.existsSync(f.schedule.workdir), false);
});
test('missing paths, malformed files and invalid workflow structures are user validation errors', t => {
  const f = fixture(t);
  for (const ittPath of ['relative.json', path.join(f.root, 'missing.json'), f.root]) {
    assert.throws(() => validateLocalSchedule({ ...f.schedule, ittPath }, f.root), ScheduleValidationError);
  }
  for (const data of ['{broken', 'null', '{}', JSON.stringify({ ...f.workflow, entry: 'missing' })]) {
    fs.writeFileSync(f.schedule.ittPath, data);
    assert.throws(() => validateLocalSchedule(f.schedule, f.root), ScheduleValidationError);
  }
});
test('typed schedule inputs reject missing, unknown and wrongly typed values before saving', t => {
  const f = fixture(t);
  for (const inputs of [{}, { ...f.schedule.inputs, count: 'abc' }, { ...f.schedule.inputs, enabled: 'yes' }, { ...f.schedule.inputs, extra: 'typo' }]) {
    assert.throws(() => validateLocalSchedule({ ...f.schedule, inputs }, f.root), ScheduleValidationError);
  }
});
test('workdirs that are relative or beneath an existing file are rejected', t => {
  const f = fixture(t);
  for (const workdir of ['relative', f.schedule.ittPath, path.join(f.schedule.ittPath, 'child')]) {
    assert.throws(() => validateLocalSchedule({ ...f.schedule, workdir }, f.root), ScheduleValidationError);
  }
  validateLocalSchedule({ ...f.schedule, inputEncoding: undefined, inputs: { count: '1', enabled: '1', label: 'legacy' } }, f.root);
});

test('preflight preserves worker-relative and legacy bucket resolution while rejecting traversal', t => {
  const f = fixture(t);
  validateLocalSchedule({ ...f.schedule, ittPath: path.basename(f.schedule.ittPath) }, f.root);
  fs.mkdirSync(path.join(f.root, 'dev'));
  fs.renameSync(f.schedule.ittPath, path.join(f.root, 'dev', path.basename(f.schedule.ittPath)));
  validateLocalSchedule({ ...f.schedule, ittPath: path.basename(f.schedule.ittPath) }, f.root);
  assert.throws(() => validateLocalSchedule({ ...f.schedule, ittPath: '../outside.json' }, f.root), /within the intent library/);
});
