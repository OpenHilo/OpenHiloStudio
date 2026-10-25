const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { inspectMigrationSource } = require('@openhilo/platform-services/migration-inspection');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-inspection-'));
  const sourceDir = path.join(root, 'source'); fs.mkdirSync(sourceDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => { const target = path.join(sourceDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); };
  return { root, sourceDir, write, inspect: options => inspectMigrationSource({ sourceDir, ...options }) };
}
function suspended(f, events = []) {
  f.write('runs/r/run.json', { run_id: 'r', status: 'suspended', workdir: path.join(f.sourceDir, 'workspace'), application: { id: 'generic', version: 1 }, ai_execution: { adapter: 'fake' } });
  f.write('runs/r/.snapshot/report.itt.impl.json', { version: 2, requiredExtensions: [{ namespace: 'sample', version: 2 }], nodes: { approve: { executor: 'human' } } });
  const history = [{ event: 'run_start', ts: 1 }, { event: 'node_suspended', node_run_id: 'r:2', ts: 2 }, ...events,
    { event: 'suspended_state', ts: 3, global_seq: 2, call_stack: [{ intent_name: 'report', current_node: 'approve', extension_state: [{ namespace: 'sample', version: 2, data: { private: 'secret-policy' } }], scope_stack: [{ vars: { ITT_WORKSPACE: path.join(f.sourceDir, 'workspace'), private: 'secret-scope' } }] }] }];
  f.write('runs/r/execution.jsonl', history.map(JSON.stringify).join('\n') + '\n'); return history;
}
test('inspects saved human state and explicit dependencies without exposing arbitrary scopes', t => {
  const f = fixture(t); suspended(f); fs.mkdirSync(path.join(f.sourceDir, 'workspace'));
  f.write('config.json', { defaults: { application: { id: 'generic', version: 1 }, ai_execution: { adapter: 'fake', api_key: 'secret-config' }, usage_router: { api_key: 'secret-router' } } });
  f.write('runs/r/run.lock', 'not-a-pid');
  const report = f.inspect(); assert.equal(report.scanComplete, true); assert.equal(report.activation, 'not_checked');
  assert.equal(report.runs[0].humanCheckpoint, 'candidate'); assert.equal(report.runs[0].lockPresent, true);
  assert.ok(report.paths.some(p => p.field.endsWith('.vars.ITT_WORKSPACE') && p.location === 'inside_source' && p.existsWithinSource));
  assert.ok(report.dependencies.some(d => d.kind === 'policy' && d.id === 'sample' && d.version === 2));
  assert.equal(JSON.stringify(report).includes('secret-'), false);
  assert.equal(fs.readFileSync(path.join(f.sourceDir, 'runs/r/run.lock'), 'utf8'), 'not-a-pid');
});
test('stale human suspension, malformed history and missing snapshot are never candidates', t => {
  for (const boundary of ['run_failed', 'run_resume', 'run_start']) {
    const f = fixture(t); suspended(f, [{ event: boundary, ts: 2.5 }]);
    assert.equal(f.inspect().runs[0].humanCheckpoint, 'missing_or_invalid');
  }
  const f = fixture(t); suspended(f);
  fs.appendFileSync(path.join(f.sourceDir, 'runs/r/execution.jsonl'), '{malformed-secret');
  let report = f.inspect(); assert.equal(report.scanComplete, false); assert.equal(report.runs[0].humanCheckpoint, 'missing_or_invalid');
  suspended(f); fs.unlinkSync(path.join(f.sourceDir, 'runs/r/.snapshot/report.itt.impl.json'));
  report = f.inspect(); assert.equal(report.runs[0].humanCheckpoint, 'missing_or_invalid');
  assert.equal(JSON.stringify(report).includes('malformed-secret'), false);
});
test('summarizes generation, pending questions and retained ownership without restoring or replaying', t => {
  const f = fixture(t);
  for (const phase of ['cc_running', 'cc_waiting_for_answer', 'auto_fixing', 'confirm_merge', 'done', 'error']) f.write(`sessions/${phase}/session.json`, { id: phase, phase, lastError: { retryable: false }, naturalLanguage: 'secret-prompt', pendingMcpQuestion: { question: 'secret-question' }, worktreePath: '/outside/worktree', aiExecutorId: 'fake', generationPolicyIdentity: { namespace: 'sample', version: 2 } });
  f.write('runs/r/ai-questions.json', { version: 1, questions: ['pending', 'answering', 'answered', 'outcome_unknown'].map(status => ({ status, instruction: 'secret-instruction', answer: 'secret-answer' })) });
  f.write('worktrees/pool-state.json', { version: 1, slots: { a: { status: 'retained', sessionId: 'review', archivePath: '/outside/archive' }, b: { status: 'idle' } } });
  const report = f.inspect();
  assert.equal(report.sessions.filter(s => s.disposition === 'terminal').length, 2);
  assert.equal(report.sessions.filter(s => s.disposition === 'review').length, 1);
  assert.equal(report.sessions.filter(s => s.disposition === 'requires_decision').length, 3);
  assert.deepEqual(report.questions[0], { file: 'runs/r/ai-questions.json', pending: 1, answering: 1, outcomeUnknown: 1 });
  assert.equal(JSON.stringify(report).includes('secret-'), false);
  assert.ok(report.issues.some(i => i.code === 'retained_worktree'));
});
test('legacy pool ownership is inspectable without promoting idle slots or rewriting its file', t => {
  const f = fixture(t);
  f.write('pool/pool-state.json', { 'ws-01': 'active:unfinished', 'ws-02': 'idle', 'ws-03': 'unknown-label', 'ws-04': 'active:' });
  const before = fs.readFileSync(path.join(f.sourceDir, 'pool/pool-state.json'));
  const report = f.inspect();
  assert.equal(report.scanComplete, true);
  assert.deepEqual(report.worktrees.map(({ slot, status, sessionId }) => ({ slot, status, ...(sessionId ? { sessionId } : {}) })), [
    { slot: 'ws-01', status: 'active', sessionId: 'unfinished' },
    { slot: 'ws-02', status: 'retained' }, { slot: 'ws-03', status: 'retained' }, { slot: 'ws-04', status: 'retained' },
  ]);
  assert.ok(report.issues.some(issue => issue.code === 'retained_worktree'));
  assert.deepEqual(fs.readFileSync(path.join(f.sourceDir, 'pool/pool-state.json')), before);
  for (const invalid of [{ '../escape': 'idle' }, { 'ws-01': {} }, { version: 2, slots: {} }]) {
    f.write('pool/pool-state.json', invalid);
    assert.equal(f.inspect().scanComplete, false);
  }
});
test('resolves legacy workflow lookup roots and reports Git/absolute/escaping paths without following them', t => {
  const f = fixture(t); f.write('intents/shared/team/report.itt.json', {});
  f.write('schedules.json', [{ id: 'valid', enabled: true, ittPath: 'team/report.itt.json' }, { id: 'bad', enabled: false, ittPath: '../private.itt.json' }]);
  f.write('worktrees/a/.git', 'gitdir: /unowned/does-not-exist\n');
  f.write('repo/.git/commondir', '../common'); f.write('repo/.git/objects/ignored.json', 'not-json');
  const report = f.inspect(); assert.equal(report.scanComplete, true);
  assert.equal(report.paths.find(p => p.field === 'schedule[valid].ittPath').existsWithinSource, true);
  assert.ok(report.issues.some(i => i.code === 'relative_path_escape'));
  assert.ok(report.issues.some(i => i.code === 'git_worktree_binding'));
  assert.ok(report.paths.some(p => p.value === '/unowned/does-not-exist' && p.location === 'outside_source' && p.existsWithinSource === undefined));
});
test('scan limits, malformed metadata and links are explicit incomplete results', t => {
  const f = fixture(t); f.write('config.json', '{secret-invalid');
  f.write('runs/r/run.json', {}); fs.symlinkSync('/outside/no-access', path.join(f.sourceDir, 'linked'));
  let report = f.inspect(); assert.equal(report.scanComplete, false);
  for (const code of ['invalid_json', 'invalid_run', 'unsupported_entry']) assert.ok(report.issues.some(i => i.code === code));
  assert.equal(JSON.stringify(report).includes('secret-invalid'), false);
  report = f.inspect({ maxEntries: 1 }); assert.ok(report.issues.some(i => i.code === 'scan_limit'));
  report = f.inspect({ maxFileBytes: 1 }); assert.ok(report.issues.some(i => i.code === 'file_limit'));
  assert.throws(() => f.inspect({ maxEntries: 0 }), /positive integers/);
  assert.throws(() => inspectMigrationSource({ sourceDir: '.' }), /absolute/);
});
test('legacy domain metadata and missing selections remain explicit review requirements', t => {
  const f = fixture(t); f.write('config.json', {}); suspended(f);
  f.write('runs/r/.snapshot/report.itt.impl.json', { level: 'strategy', nodes: { approve: { executor: 'human' } } });
  const report = f.inspect(); assert.equal(report.dependencies.some(d => d.inferred), false);
  assert.ok(report.issues.some(i => i.code === 'missing_selection'));
  assert.ok(report.issues.some(i => i.code === 'legacy_domain_metadata'));
});
test('CLI is read-only and inspector loads only the pure runtime codec without providers, domain, DB or child processes', t => {
  const f = fixture(t); suspended(f); const before = fs.readFileSync(path.join(f.sourceDir, 'runs/r/execution.jsonl'));
  const cli = require.resolve('@openhilo/platform-services/data-migration-cli');
  const report = JSON.parse(execFileSync(process.execPath, [cli, 'inspect', '--source', f.sourceDir], { encoding: 'utf8' }));
  assert.equal(report.runs[0].humanCheckpoint, 'candidate');
  assert.deepEqual(fs.readFileSync(path.join(f.sourceDir, 'runs/r/execution.jsonl')), before);
  execFileSync(process.execPath, ['-e', `
    const Module = require('node:module'), original = Module._load;
    Module._load = function(id, ...args) {
      if (id === '@openhilo/runtime' || /ai-claude|ai-sdk|@intentorch|better-sqlite3|openai|anthropic|child_process|@intentorch\\/runtime/.test(id)) throw new Error('Forbidden dependency: ' + id);
      return original.call(this, id, ...args);
    };
    process.kill = () => { throw new Error('Unexpected process probe'); };
    global.fetch = () => { throw new Error('Unexpected network'); };
    require('@openhilo/platform-services/migration-inspection').inspectMigrationSource({sourceDir: process.argv[1]});
  `, f.sourceDir], { stdio: 'pipe' });
});
