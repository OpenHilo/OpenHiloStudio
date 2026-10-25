const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { initializeLocalHome } = require('@openhilo/server/local-initialize');
const { BRAIN_TSCONFIG, SYS_GLOBALS_DTS } = require('@openhilo/platform-services/brain-template');
const { platformSystemMethods } = require('@openhilo/platform-services/compiler-capabilities');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-init-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, home: path.join(root, 'new') };
}
const configuration = { format: 'intentorch.deployment', version: 1, core: { legacyFields: {} }, domain: { selection: { id: 'generic', version: 1 }, applications: {} }, ai: { execution: { adapter: 'fixture' }, implementations: {} }, legacy: {} };
test('initializes a private new home with explicit configuration and committed generic compiler declarations', t => {
  const f = fixture(t); assert.deepEqual(initializeLocalHome({ ...f, configuration }), { home: f.home, status: 'ready' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'))), configuration);
  assert.equal(fs.statSync(f.home).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(f.home, 'config.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'deployment.json'))).status, 'ready');
  assert.equal(fs.existsSync(path.join(f.home, 'entities.db')), false); assert.deepEqual(fs.readdirSync(path.join(f.home, 'pool')), []);
  const brain = path.join(f.home, 'brain');
  assert.equal(fs.readFileSync(path.join(brain, 'sys-globals.d.ts'), 'utf8'), SYS_GLOBALS_DTS);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(brain, 'tsconfig.json'))), JSON.parse(BRAIN_TSCONFIG));
  for (const method of Object.keys(platformSystemMethods)) assert.ok(SYS_GLOBALS_DTS.includes(`function ${method}_by_sys(`), method);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: brain, encoding: 'utf8' }), '');
  assert.match(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: brain, encoding: 'utf8' }), /Initialize generic/);
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', path.join(brain, 'tsconfig.json')], { stdio: 'pipe' });
});
test('rejects existing homes, links, relative paths and implicit legacy configuration without rewriting data', t => {
  const f = fixture(t); initializeLocalHome({ ...f, configuration });
  fs.writeFileSync(path.join(f.home, 'keep'), 'unchanged');
  assert.throws(() => initializeLocalHome({ ...f, configuration }), /exist/i);
  assert.equal(fs.readFileSync(path.join(f.home, 'keep'), 'utf8'), 'unchanged');
  assert.throws(() => initializeLocalHome({ home: '.', configuration }), /absolute/);
  assert.throws(() => initializeLocalHome({ home: path.join(f.root, 'legacy'), configuration: {} }), /unsupported/);
  assert.equal(fs.existsSync(path.join(f.root, 'legacy')), false);
  const link = path.join(f.root, 'link'); fs.symlinkSync(path.join(f.root, 'absent'), link);
  assert.throws(() => initializeLocalHome({ home: link, configuration }), /exist/i);
  assert.equal(fs.existsSync(path.join(f.root, 'absent')), false);
});
test('failed Git initialization keeps partial state and reports failure without echoing private configuration', t => {
  const f = fixture(t), config = path.join(f.root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ ...configuration, legacy: { private: 'do-not-echo' } }));
  const result = spawnSync(process.execPath, [require.resolve('@openhilo/server/local-cli'), 'init', '--home', f.home, '--config', config], { env: { ...process.env, PATH: '' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.equal(result.stderr.includes('do-not-echo'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'deployment.json'))).status, 'failed');
  assert.ok(fs.existsSync(path.join(f.home, 'config.json')));
  const composition = path.join(f.root, 'never-load.cjs'); fs.writeFileSync(composition, "throw new Error('Composition must not load')");
  const start = spawnSync(process.execPath, [require.resolve('@openhilo/server/local-cli'), 'start', '--home', f.home, '--composition', composition], { encoding: 'utf8' });
  assert.equal(start.status, 1); assert.match(start.stderr, /initialization is not ready/);
  assert.equal(start.stderr.includes('Composition must not load'), false);
});
test('CLI init requires explicit config and does not load any provider or application implementation', t => {
  const f = fixture(t), config = path.join(f.root, 'config.json'), guard = path.join(f.root, 'guard.cjs'); fs.writeFileSync(config, JSON.stringify(configuration));
  fs.writeFileSync(guard, `const Module=require('node:module'),load=Module._load;Module._load=function(id,...args){if(/ai-sdk|ai-claude|@intentorch|anthropic|^openai$|node-pty/.test(id))throw new Error('Unexpected implementation');return load.call(this,id,...args)};global.fetch=()=>{throw new Error('Unexpected network')};`);
  const output = execFileSync(process.execPath, ['--require', guard, require.resolve('@openhilo/server/local-cli'), 'init', '--home', f.home, '--config', config], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).status, 'ready');
  assert.equal(fs.existsSync(path.join(f.home, 'entities.db')), false);
});
