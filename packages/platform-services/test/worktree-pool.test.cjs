const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { git } = require('../dist/publication');
const { WorktreePool } = require('../dist/worktree-pool');
const { spawnSync } = require('node:child_process');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-leases-'));
  const brainDir = path.join(root, 'brain'), poolDir = path.join(root, 'pool'); fs.mkdirSync(brainDir);
  git(brainDir, ['init', '-b', 'main']); git(brainDir, ['config', 'user.name', 'Fixture']); git(brainDir, ['config', 'user.email', 'fixture@local']);
  fs.writeFileSync(path.join(brainDir, 'source.ts'), 'original'); git(brainDir, ['add', '.']); git(brainDir, ['commit', '-m', 'fixture']);
  const options = { brainDir, poolDir, size: 1 }; const pool = new WorktreePool(options);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, brainDir, poolDir, options, pool };
}

test('active ownership persists across new instances and blocks reuse by other sessions', t => {
  const f = setup(t); const directory = f.pool.checkout('one');
  fs.writeFileSync(path.join(directory, 'uncommitted.txt'), 'keep me');
  const restarted = new WorktreePool(f.options); restarted.initialize();
  assert.equal(restarted.snapshot()['ws-01'].sessionId, 'one');
  assert.throws(() => restarted.checkout('two'), error => {
    assert.match(error.message, /No translator slot/);
    assert.deepEqual(error.blockingSessionIds, ['one']);
    return true;
  });
  assert.throws(() => restarted.release(directory, 'two'), /does not belong/);
  restarted.assertOwner(directory, 'one');
  assert.equal(fs.readFileSync(path.join(directory, 'uncommitted.txt'), 'utf8'), 'keep me');
});

test('release archives tracked, untracked and ignored files, and subsequent checkout starts fresh', t => {
  const f = setup(t); const directory = f.pool.checkout('one');
  fs.writeFileSync(path.join(directory, 'source.ts'), 'edited');
  fs.writeFileSync(path.join(directory, 'uncommitted.txt'), 'keep');
  fs.writeFileSync(path.join(directory, '.gitignore'), 'ignored.txt\n'); fs.writeFileSync(path.join(directory, 'ignored.txt'), 'also keep');
  const archive = f.pool.release(directory, 'one');
  for (const [file, value] of [['source.ts', 'edited'], ['uncommitted.txt', 'keep'], ['ignored.txt', 'also keep']]) assert.equal(fs.readFileSync(path.join(archive, file), 'utf8'), value);
  assert.equal(JSON.parse(fs.readFileSync(archive + '.lease.json', 'utf8')).sessionId, 'one');
  const fresh = new WorktreePool(f.options).checkout('two');
  assert.equal(fs.readFileSync(path.join(fresh, 'source.ts'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(fresh, 'uncommitted.txt')), false);
  assert.equal(fs.readFileSync(path.join(archive, 'uncommitted.txt'), 'utf8'), 'keep');
});

test('unknown existing and legacy idle worktrees are retained until explicit ownership migration', t => {
  const f = setup(t); fs.mkdirSync(f.poolDir);
  const directory = path.join(f.poolDir, 'ws-01'); git(f.brainDir, ['worktree', 'add', '--detach', directory, 'HEAD']);
  fs.writeFileSync(path.join(directory, 'draft.ts'), 'draft');
  fs.writeFileSync(path.join(f.poolDir, 'pool-state.json'), JSON.stringify({ 'ws-01': 'idle' }));
  f.pool.initialize(); assert.equal(f.pool.snapshot()['ws-01'].status, 'retained');
  assert.throws(() => f.pool.checkout('new'), /No translator slot/);
  f.pool.claimRetained(directory, 'restored'); f.pool.assertOwner(directory, 'restored');
  assert.equal(fs.readFileSync(path.join(directory, 'draft.ts'), 'utf8'), 'draft');
});

test('locks and corrupt state are never silently deleted or reset', t => {
  const f = setup(t); f.pool.initialize();
  fs.writeFileSync(path.join(f.poolDir, '.pool.lock'), 'unknown owner');
  assert.throws(() => f.pool.initialize(), /locked or has an interrupted/);
  assert.equal(fs.readFileSync(path.join(f.poolDir, '.pool.lock'), 'utf8'), 'unknown owner');
  fs.unlinkSync(path.join(f.poolDir, '.pool.lock'));
  fs.writeFileSync(path.join(f.poolDir, 'pool-state.json'), '{truncated');
  assert.throws(() => f.pool.checkout('new'));
  assert.equal(fs.readFileSync(path.join(f.poolDir, 'pool-state.json'), 'utf8'), '{truncated');
});

test('interrupted archival is recovered from the recorded move without clearing files', t => {
  const f = setup(t); const directory = f.pool.checkout('one');
  fs.writeFileSync(path.join(directory, 'draft.ts'), 'preserve');
  const destination = path.join(f.poolDir, 'archives', 'ws-01-interrupted'); fs.mkdirSync(path.dirname(destination));
  fs.writeFileSync(path.join(f.poolDir, 'pool-state.json'), JSON.stringify({ version: 1, slots: { 'ws-01': { status: 'archiving', sessionId: 'one', archivePath: destination } } }));
  git(f.brainDir, ['worktree', 'move', directory, destination]);
  assert.equal(new WorktreePool(f.options).recoverArchival('ws-01'), destination);
  assert.equal(fs.readFileSync(path.join(destination, 'draft.ts'), 'utf8'), 'preserve');
  assert.equal(f.pool.snapshot()['ws-01'].status, 'vacant');
});

test('wrong repository and outside paths cannot be claimed or released', t => {
  const f = setup(t); const directory = f.pool.checkout('one');
  assert.throws(() => f.pool.release(f.brainDir, 'one'), /outside|Invalid pool slot/);
  assert.throws(() => f.pool.assertOwner(directory, 'other'), /does not belong/);
});

test('explicit legacy archival preserves unknown contents and makes the slot reusable', t => {
  const f = setup(t); fs.mkdirSync(f.poolDir);
  const directory = path.join(f.poolDir, 'ws-01'); git(f.brainDir, ['worktree', 'add', '--detach', directory, 'HEAD']);
  fs.writeFileSync(path.join(directory, 'old.txt'), 'legacy draft');
  f.pool.initialize();
  const archived = f.pool.archiveRetained('ws-01');
  assert.equal(fs.readFileSync(path.join(archived, 'old.txt'), 'utf8'), 'legacy draft');
  assert.equal(f.pool.checkout('new'), directory);
  assert.equal(fs.existsSync(path.join(directory, 'old.txt')), false);
});

test('operator CLI inspects without initialization and preserves drafts and locks during explicit migration', t => {
  const f = setup(t);
  const cli = path.resolve(__dirname, '../dist/worktree-cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(run('--help').status, 0);
  assert.equal(run('claim').status, 1);
  const initial = run('inspect', f.brainDir, f.poolDir);
  assert.equal(initial.status, 0, initial.stderr);
  assert.deepEqual(JSON.parse(initial.stdout), {});
  assert.equal(fs.existsSync(f.poolDir), false);
  fs.mkdirSync(f.poolDir);
  const directory = path.join(f.poolDir, 'ws-01');
  git(f.brainDir, ['worktree', 'add', '--detach', directory, 'HEAD']);
  fs.writeFileSync(path.join(directory, 'draft.ts'), 'keep draft');
  assert.equal(run('initialize', f.brainDir, f.poolDir).status, 0);
  const archived = run('archive-retained', f.brainDir, f.poolDir, 'ws-01');
  assert.equal(archived.status, 0, archived.stderr);
  assert.equal(fs.readFileSync(path.join(archived.stdout.trim(), 'draft.ts'), 'utf8'), 'keep draft');
  fs.writeFileSync(path.join(f.poolDir, '.pool.lock'), 'unknown owner');
  assert.equal(run('initialize', f.brainDir, f.poolDir).status, 1);
  assert.equal(fs.readFileSync(path.join(f.poolDir, '.pool.lock'), 'utf8'), 'unknown owner');
});
