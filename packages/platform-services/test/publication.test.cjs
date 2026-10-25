const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { git, prepareCandidate, publishCandidate, recoverPublication, verifyCandidate, readArtifactTree, withStableArtifactTree } = require('../dist/publication');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-publish-'));
  const brainDir = path.join(root, 'brain $ literal');
  const worktree = path.join(root, 'candidate');
  const intentsDir = path.join(root, 'intents');
  fs.mkdirSync(brainDir); fs.mkdirSync(intentsDir);
  git(brainDir, ['init', '-b', 'main']);
  git(brainDir, ['config', 'user.email', 'fixture@local']); git(brainDir, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(brainDir, 'existing.ts'), 'export const before = true;');
  git(brainDir, ['add', '.']); git(brainDir, ['commit', '-m', 'fixture']);
  git(brainDir, ['worktree', 'add', '-b', 'candidate', worktree]);
  fs.writeFileSync(path.join(worktree, 'new.ts'), 'export const after = true;');
  fs.writeFileSync(path.join(intentsDir, 'existing.json'), 'old artifact');
  const candidate = prepareCandidate({ brainDir, worktree, intentsDir, sources: { 'new.ts': 'export const after = true;' },
    artifacts: { ...readArtifactTree(intentsDir), 'new.json': Buffer.from('new artifact').toString('base64') } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, candidate, brainDir, worktree, intentsDir };
}

test('source publication uses the reviewed receipt, preserving prior artifacts and a completed journal', t => {
  const f = setup(t);
  publishCandidate(f.candidate, 'literal $(not-a-shell)');
  assert.equal(fs.readFileSync(path.join(f.brainDir, 'new.ts'), 'utf8'), f.candidate.sources['new.ts']);
  assert.equal(fs.readFileSync(path.join(f.intentsDir, 'existing.json'), 'utf8'), 'old artifact');
  assert.equal(fs.readFileSync(path.join(f.intentsDir, 'new.json'), 'utf8'), 'new artifact');
  const transaction = path.join(f.root, '.intentorch-publications', f.candidate.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(transaction, 'journal.json'), 'utf8')).phase, 'completed');
  assert.equal(fs.readFileSync(path.join(transaction, 'previous-artifacts', 'existing.json'), 'utf8'), 'old artifact');
  assert.equal(git(f.brainDir, ['status', '--porcelain']).trim(), '');
  assert.throws(() => publishCandidate(f.candidate, 'again'), /base changed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(transaction, 'journal.json'), 'utf8')).phase, 'completed');
});

test('source or target changes invalidate approval before mutation', t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.worktree, 'new.ts'), 'changed after review');
  assert.throws(() => publishCandidate(f.candidate, 'test'), /source changed/);
  assert.equal(fs.existsSync(path.join(f.brainDir, 'new.ts')), false);
  fs.writeFileSync(path.join(f.worktree, 'new.ts'), f.candidate.sources['new.ts']);
  fs.writeFileSync(path.join(f.intentsDir, 'manual.json'), 'keep');
  assert.throws(() => verifyCandidate(f.candidate), /artifacts changed/);
  assert.equal(fs.readFileSync(path.join(f.intentsDir, 'manual.json'), 'utf8'), 'keep');
});

test('dirty Brain and unrelated staged changes are preserved and block publication', t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.brainDir, 'personal.txt'), 'do not clean');
  assert.throws(() => publishCandidate(f.candidate, 'test'), /local changes/);
  assert.equal(fs.readFileSync(path.join(f.brainDir, 'personal.txt'), 'utf8'), 'do not clean');
  fs.unlinkSync(path.join(f.brainDir, 'personal.txt'));
  fs.writeFileSync(path.join(f.worktree, 'other.txt'), 'staged'); git(f.worktree, ['add', 'other.txt']);
  assert.throws(() => publishCandidate(f.candidate, 'test'), /unreviewed tracked/);
  assert.equal(git(f.worktree, ['diff', '--cached', '--name-only']).trim(), 'other.txt');
});

test('unwritable publication lock is reported as a write failure, preserving the candidate', t => {
  const f = setup(t), mkdir = fs.mkdirSync;
  const lock = path.join(f.root, '.intentorch-publication-lock');
  fs.mkdirSync = (directory, ...options) => {
    if (directory === lock) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return mkdir(directory, ...options);
  };
  try { assert.throws(() => publishCandidate(f.candidate, 'test'), /Cannot start publication.*EACCES/); }
  finally { fs.mkdirSync = mkdir; }
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(path.join(f.brainDir, 'new.ts')), false);
  assert.equal(fs.readFileSync(path.join(f.worktree, 'new.ts'), 'utf8'), f.candidate.sources['new.ts']);
  publishCandidate(f.candidate, 'retry after permission restored');
  assert.equal(fs.readFileSync(path.join(f.intentsDir, 'new.json'), 'utf8'), 'new artifact');
});

test('tampered receipt and symlink inputs fail before publication', t => {
  const f = setup(t);
  assert.throws(() => verifyCandidate({ ...f.candidate, artifacts: {} }), /Invalid publication receipt/);
  fs.unlinkSync(path.join(f.worktree, 'new.ts'));
  fs.symlinkSync(path.join(f.brainDir, 'existing.ts'), path.join(f.worktree, 'new.ts'));
  assert.throws(() => verifyCandidate(f.candidate), /symlink/);
});

test('activation failure restores prior artifacts and retains a recovery journal and lock', t => {
  const f = setup(t);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.basename(from) === 'artifacts' && to === f.intentsDir) throw new Error('fixture disk activation failure');
    return rename(from, to);
  };
  try { assert.throws(() => publishCandidate(f.candidate, 'test'), /activation failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(path.join(f.intentsDir, 'existing.json'), 'utf8'), 'old artifact');
  assert.equal(fs.existsSync(path.join(f.intentsDir, 'new.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.intentorch-publication-lock')), true);
  const record = JSON.parse(fs.readFileSync(path.join(f.root, '.intentorch-publications', f.candidate.id, 'journal.json'), 'utf8'));
  assert.equal(record.phase, 'needs_recovery'); assert.ok(record.sourceRevision);
  assert.throws(() => publishCandidate(f.candidate, 'test'), /locked or interrupted/);
  const staged = path.join(f.root, '.intentorch-publications', f.candidate.id, 'artifacts', 'new.json');
  fs.writeFileSync(staged, 'changed after failure');
  assert.throws(() => recoverPublication(f.intentsDir, 'complete'), /Staged artifacts changed/);
  fs.writeFileSync(staged, 'new artifact');
  recoverPublication(f.intentsDir, 'complete');
  assert.equal(fs.readFileSync(path.join(f.intentsDir, 'new.json'), 'utf8'), 'new artifact');
  assert.equal(fs.existsSync(path.join(f.root, '.intentorch-publication-lock')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '.intentorch-publications', f.candidate.id, 'journal.json'), 'utf8')).phase, 'completed');
});


test('snapshot readers reject active publication and directory replacement during collection', t => {
  const f = setup(t);
  fs.mkdirSync(path.join(f.root, '.intentorch-publication-lock'));
  assert.throws(() => withStableArtifactTree(f.intentsDir, () => 'read'), /publication is active/);
  fs.rmdirSync(path.join(f.root, '.intentorch-publication-lock'));
  assert.throws(() => withStableArtifactTree(f.intentsDir, () => {
    fs.renameSync(f.intentsDir, path.join(f.root, 'old-intents'));
    fs.mkdirSync(f.intentsDir);
    return 'mixed read';
  }), /changed while reading/);
});
