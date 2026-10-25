const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const demoDir = path.join(
  path.dirname(require.resolve('@openhilo/server')),
  '..',
  'examples',
  'offline-demo'
);

test(
  'packaged offline walkthrough composes generation, publication, SQLite, workers, recovery, scheduling and shutdown without live AI',
  { timeout: 30000 },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-demo-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'data');
    fs.mkdirSync(home);
    const guard = path.join(root, 'guard.cjs');
    fs.writeFileSync(
      guard,
      `
    const Module = require('node:module'), load = Module._load;
    Module._load = function(name, ...args) {
      if (/ai-claude|ai-sdk|@intentorch|anthropic|^openai$|node-pty/.test(name)) throw new Error('Forbidden demo dependency: ' + name);
      return load.call(this, name, ...args);
    };
    globalThis.fetch = () => { throw new Error('Outbound fetch forbidden in offline demo'); };
  `
    );
    const output = execFileSync(
      process.execPath,
      [
        '--require',
        guard,
        '-e',
        `
    require(${JSON.stringify(path.join(demoDir, 'run.cjs'))}).walkthrough(${JSON.stringify(home)})
      .catch(error => { console.error(error); process.exitCode = 1; });
  `,
      ],
      { encoding: 'utf8', timeout: 25000, env: { ...process.env, NODE_OPTIONS: `--require=${guard}` } }
    );
    const result = JSON.parse(fs.readFileSync(path.join(home, 'result.json'), 'utf8'));
    assert.equal(result.output, 'Concise: OpenHilo modular architecture');
    assert.equal(result.aiRequests, 'scripted only');
    assert.ok(result.sessionId && result.runId && result.scheduledRunId);
    assert.match(output, /status=completed/);
    assert.ok(fs.existsSync(path.join(home, 'entities.db')));
  }
);

test('demo initialization refuses existing data and open refuses a different deployment identity', async (t) => {
  const { initializeDemo, openDemo } = require(path.join(demoDir, 'host.cjs'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-demo-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'keep.txt'), 'owned by user');
  assert.throws(() => initializeDemo(root), /empty absolute demo directory/);
  fs.writeFileSync(path.join(root, 'demo.json'), JSON.stringify({ version: 9, aiExecutorId: 'different' }));
  await assert.rejects(openDemo(root), /Incompatible/);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'owned by user');
  assert.equal(fs.existsSync(path.join(root, 'entities.db')), false);
});
