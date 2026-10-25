const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { planPathRebinding, migratePathsCopy } = require('@openhilo/platform-services/path-migration');
const { toDeploymentConfig } = require('@openhilo/platform-services/deployment-config');
const { restoreMigrationBackup } = require('@openhilo/platform-services/data-migration');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'path-migration-'))), sourceDir = path.join(root, 'source'), bundleDir = path.join(root, 'bundle');
  fs.mkdirSync(sourceDir); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => { const target = path.join(sourceDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); };
  const read = (file, tree = path.join(bundleDir, 'data')) => JSON.parse(fs.readFileSync(path.join(tree, file)));
  return { root, sourceDir, bundleDir, write, read };
}
test('known paths migrate in a backup copy; IDs, schedule state, unknown values and Git pointers remain intact', async t => {
  const f = fixture(t), workspace = path.join(f.sourceDir, 'workspace'), target = path.join(f.bundleDir, 'data');
  const sameText = `${workspace}/secret-private-prompt`;
  f.write('config.json', { defaults: { claude_path: path.join(f.sourceDir, 'bin/claude'), private: sameText } });
  f.write('runs/r/run.json', { run_id: 'r', status: 'completed', workdir: workspace, itt_home: f.sourceDir, private: sameText });
  f.write('schedules.json', [{ id: 'scheduled', enabled: true, ittPath: path.join(f.sourceDir, 'intents/dev/report.itt.json'), workdir: workspace, cron: '0 * * * *', parameters: { private: sameText } }]);
  f.write('sessions/s/session.json', { id: 's', phase: 'confirm_merge', sessionDir: path.join(f.sourceDir, 'sessions/s'), worktreePath: '/external/worktree', config: { workspace, dbPath: path.join(f.sourceDir, 'entities.db') }, savedPaths: [path.join(f.sourceDir, 'intents/report.itt.json')], naturalLanguage: sameText });
  f.write('worktrees/pool-state.json', { version: 1, slots: { 'a/b': { status: 'retained', sessionId: 's', archivePath: path.join(f.sourceDir, 'archive/a') } } });
  f.write('worktrees/a/.git', `gitdir: ${f.sourceDir}/repo/.git/worktrees/a\n`);
  const plan = planPathRebinding(f); assert.equal(plan.activation, 'not_checked'); assert.equal(JSON.stringify(plan).includes('secret-private-prompt'), false);
  assert.ok(plan.unresolved.some(p => p.field === 'gitdir')); assert.ok(plan.unresolved.some(p => p.value === '/external/worktree'));
  const before = fs.readFileSync(path.join(f.sourceDir, 'schedules.json'));
  const report = await migratePathsCopy({ plan, bundleDir: f.bundleDir }); assert.equal(report.status, 'completed'); assert.equal(report.activation, 'not_activated');
  assert.equal(f.read('runs/r/run.json').workdir, path.join(target, 'workspace'));
  assert.equal(f.read('runs/r/run.json').run_id, 'r'); assert.equal(f.read('runs/r/run.json').private, sameText);
  assert.equal(f.read('config.json').defaults.claude_path, path.join(target, 'bin/claude'));
  const schedule = f.read('schedules.json')[0]; assert.equal(schedule.id, 'scheduled'); assert.equal(schedule.enabled, true); assert.equal(schedule.parameters.private, sameText);
  assert.equal(schedule.ittPath, path.join(target, 'intents/dev/report.itt.json'));
  const session = f.read('sessions/s/session.json'); assert.equal(session.phase, 'confirm_merge'); assert.equal(session.worktreePath, '/external/worktree'); assert.equal(session.naturalLanguage, sameText);
  assert.equal(session.savedPaths[0], path.join(target, 'intents/report.itt.json'));
  assert.equal(f.read('worktrees/pool-state.json').slots['a/b'].archivePath, path.join(target, 'archive/a'));
  assert.equal(fs.readFileSync(path.join(target, 'worktrees/a/.git'), 'utf8'), `gitdir: ${f.sourceDir}/repo/.git/worktrees/a\n`);
  assert.deepEqual(fs.readFileSync(path.join(f.sourceDir, 'schedules.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(f.bundleDir, 'backup/schedules.json')), before);
  const restored = path.join(f.root, 'restored'); restoreMigrationBackup(f.bundleDir, restored);
  assert.deepEqual(fs.readFileSync(path.join(restored, 'schedules.json')), before);
});
test('flat and namespaced configuration paths use their actual owned locations', async t => {
  for (const format of ['flat', 'generic', 'legacy-adapter']) {
    const f = fixture(t); const config = { claude_path: path.join(f.sourceDir, 'bin/claude'), mcp_server_js: path.join(f.sourceDir, 'mcp.js'), private: 'unchanged' };
    let stored = config;
    if (format !== 'flat') {
      stored = toDeploymentConfig({ ...config, application: { id: 'generic', version: 1 }, ai_execution: { adapter: 'example' } });
      if (format === 'legacy-adapter') {
        stored.ai.implementations['claude-code'] = { claude_path: config.claude_path, mcp_server_js: config.mcp_server_js };
        delete stored.core.legacyFields.claude_path; delete stored.core.legacyFields.mcp_server_js;
      }
    }
    f.write('config.json', stored);
    const plan = planPathRebinding(f); await migratePathsCopy({ plan, bundleDir: f.bundleDir });
    const saved = f.read('config.json'), native = format === 'legacy-adapter' ? saved.ai.implementations['claude-code'] : format === 'generic' ? saved.core.legacyFields : saved;
    assert.equal(native.claude_path, path.join(f.bundleDir, 'data/bin/claude'));
    assert.equal(native.mcp_server_js, path.join(f.bundleDir, 'data/mcp.js'));
  }
});
test('external prefix mappings require explicit input, select longest boundary match and never copy external data', async t => {
  const f = fixture(t); f.write('schedules.json', ['/old/work/one', '/old/work/special/two', '/old/workish/three'].map((workdir, i) => ({ id: String(i), enabled: false, workdir, ittPath: 'report.itt.json' })));
  const plan = planPathRebinding({ ...f, mappings: [{ from: '/old/work', to: '/new/work' }, { from: '/old/work/special', to: '/new/special' }] });
  await migratePathsCopy({ plan, bundleDir: f.bundleDir });
  assert.deepEqual(f.read('schedules.json').map(s => s.workdir), ['/new/work/one', '/new/special/two', '/old/workish/three']);
  assert.deepEqual(fs.readdirSync(path.join(f.bundleDir, 'data')), ['schedules.json']);
  assert.ok(plan.unresolved.some(p => p.value === '/old/workish/three'));
});
test('stale source, altered edits, destination changes and unsupported pointers fail before creating a bundle', async t => {
  const f = fixture(t); f.write('runs/r/run.json', { run_id: 'r', status: 'completed', workdir: f.sourceDir, private: 'keep' });
  const plan = planPathRebinding(f);
  for (const mutate of [p => { p.files[0].edits[0].to = '/unapproved'; }, p => { p.files[0].edits[0].keys = ['private']; }, p => { p.files[0].file = '../outside'; }, p => { p.review = []; }]) {
    const changed = structuredClone(plan); mutate(changed);
    await assert.rejects(migratePathsCopy({ plan: changed, bundleDir: f.bundleDir }), /stale or altered/);
    assert.equal(fs.existsSync(f.bundleDir), false);
  }
  await assert.rejects(migratePathsCopy({ plan, bundleDir: path.join(f.root, 'other') }), /stale or altered/);
  f.write('runs/r/run.json', { run_id: 'r', status: 'completed', workdir: f.sourceDir, private: 'changed' });
  await assert.rejects(migratePathsCopy({ plan, bundleDir: f.bundleDir }), /stale or altered/);
  assert.equal(fs.existsSync(f.bundleDir), false);
});
test('invalid inspections, suspended checkpoints, duplicate or overlapping mappings and invalid destinations fail closed', t => {
  const f = fixture(t); f.write('config.json', '{bad');
  assert.throws(() => planPathRebinding(f), /complete metadata inspection/);
  f.write('config.json', {}); f.write('runs/r/run.json', { run_id: 'r', status: 'suspended', workdir: f.sourceDir });
  assert.throws(() => planPathRebinding(f), /valid human checkpoint/);
  fs.unlinkSync(path.join(f.sourceDir, 'runs/r/run.json'));
  assert.throws(() => planPathRebinding({ ...f, mappings: [{ from: f.sourceDir, to: '/another' }] }), /overlap/);
  assert.throws(() => planPathRebinding({ ...f, mappings: [{ from: '/old', to: '/new' }, { from: '/old', to: '/newer' }] }), /unique/);
  assert.throws(() => planPathRebinding({ ...f, mappings: {} }), /array/);
  assert.throws(() => planPathRebinding({ ...f, bundleDir: path.join(f.sourceDir, 'bundle') }), /outside/);
  fs.symlinkSync('/unknown/no-data', path.join(f.sourceDir, 'link'));
  assert.throws(() => planPathRebinding(f), /complete metadata inspection/);
});
test('CLI saves a private plan outside source, applies it once and does not echo invalid JSON values', t => {
  const f = fixture(t); f.write('config.json', { claude_path: path.join(f.sourceDir, 'bin/claude') });
  const cli = require.resolve('@openhilo/platform-services/data-migration-cli'), planFile = path.join(f.root, 'plan.json');
  const run = args => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }));
  const planned = run(['plan-paths', '--source', f.sourceDir, '--bundle', f.bundleDir, '--plan', planFile]);
  assert.equal(planned.status, 'planned'); assert.equal(fs.statSync(planFile).mode & 0o777, 0o600); assert.equal(fs.existsSync(f.bundleDir), false);
  assert.equal(run(['migrate-paths', '--plan', planFile, '--bundle', f.bundleDir]).activation, 'not_activated');
  assert.notEqual(spawnSync(process.execPath, [cli, 'migrate-paths', '--plan', planFile, '--bundle', f.bundleDir]).status, 0);
  const bad = path.join(f.root, 'bad.json'); fs.writeFileSync(bad, '{"private":"do-not-echo"');
  const result = spawnSync(process.execPath, [cli, 'migrate-paths', '--plan', bad, '--bundle', path.join(f.root, 'next')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.equal(result.stderr.includes('do-not-echo'), false);
  const inside = path.join(f.sourceDir, 'plan.json');
  const invalid = spawnSync(process.execPath, [cli, 'plan-paths', '--source', f.sourceDir, '--bundle', path.join(f.root, 'next'), '--plan', inside], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0); assert.equal(fs.existsSync(inside), false);
});
test('public planner loads only the pure runtime codec without providers/domain/database/processes and never probes a PID', t => {
  const f = fixture(t); f.write('config.json', {});
  execFileSync(process.execPath, ['-e', `
    const Module = require('node:module'), original = Module._load;
    Module._load = function(id, ...args) {
      if (id === '@openhilo/runtime' || /ai-claude|ai-sdk|@intentorch|better-sqlite3|openai|anthropic|child_process|@intentorch\\/runtime/.test(id)) throw new Error('Forbidden dependency: ' + id);
      return original.call(this, id, ...args);
    };
    process.kill = () => { throw new Error('Unexpected PID probe'); };
    global.fetch = () => { throw new Error('Unexpected network'); };
    require('@openhilo/platform-services/path-migration').planPathRebinding({sourceDir: process.argv[1], bundleDir: process.argv[2]});
  `, f.sourceDir, f.bundleDir], { stdio: 'pipe' });
});

test('graph checkpoint path rebinding preserves shared values and earlier journal bytes', async t => {
  const { encodeStateGraph, decodeCheckpointStack } = require('@openhilo/runtime/state-graph');
  const f = fixture(t), workspace = path.join(f.sourceDir, 'workspace');
  const shared = { count: 3, enabled: false };
  const checkpoint = { event: 'suspended_state', ts: 3, global_seq: 1, call_stack: encodeStateGraph([{
    intent_name: 'flow', current_node: 'review', extension_state: [], scope_stack: [{ kind: 'base', vars: { ITT_WORKSPACE: workspace, a: shared, b: shared } }],
  }]) };
  const prefix = '{"event":"node_suspended","node_run_id":"first","ts":2}\r\n';
  f.write('runs/r/run.json', { run_id: 'r', status: 'suspended', workdir: workspace });
  f.write('runs/r/.snapshot/flow.itt.impl.json', { nodes: { review: { executor: 'human' } } });
  f.write('runs/r/execution.jsonl', prefix + JSON.stringify(checkpoint) + '\n');
  const plan = planPathRebinding(f);
  await migratePathsCopy({ plan, bundleDir: f.bundleDir });
  const content = fs.readFileSync(path.join(f.bundleDir, 'data/runs/r/execution.jsonl'), 'utf8');
  assert.ok(content.startsWith(prefix));
  const saved = JSON.parse(content.trimEnd().split('\n').at(-1));
  assert.equal(saved.call_stack.format, 'openhilo-state-graph');
  const vars = decodeCheckpointStack(saved.call_stack)[0].scope_stack[0].vars;
  assert.equal(vars.ITT_WORKSPACE, path.join(f.bundleDir, 'data/workspace'));
  assert.deepEqual(vars.a, { count: 3, enabled: false });
  assert.equal(vars.a, vars.b);
  assert.equal(fs.readFileSync(path.join(f.sourceDir, 'runs/r/execution.jsonl'), 'utf8'), prefix + JSON.stringify(checkpoint) + '\n');
});
