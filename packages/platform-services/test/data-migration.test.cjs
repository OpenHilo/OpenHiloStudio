const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { EntityStore } = require('@openhilo/platform-services/entity-store');
const { migrateDataCopy, restoreMigrationBackup, planBrainDirectoryMigration, migrateBrainDirectoriesCopy } = require('@openhilo/platform-services/data-migration');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-migration-'));
  const sourceDir = path.join(root, 'source'), bundleDir = path.join(root, 'bundle'); fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, 'config.json'), JSON.stringify({ unknown: { keep: true }, api_key: 'test-secret' }), { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sourceDir, bundleDir };
}
const readReport = f => JSON.parse(fs.readFileSync(path.join(f.bundleDir, 'report.json'), 'utf8'));

test('migrates a real legacy SQLite copy without changing IDs, versions, unknown tables or the original', async t => {
  const f = fixture(t), dbFile = path.join(f.sourceDir, 'entities.db');
  const legacy = new Database(dbFile);
  legacy.exec(`CREATE TABLE classes(name TEXT PRIMARY KEY, schema TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE entities(id TEXT PRIMARY KEY, class_name TEXT NOT NULL, data TEXT NOT NULL, _version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE customer_extension(value TEXT); INSERT INTO customer_extension VALUES ('keep');
    INSERT INTO classes VALUES ('Document','{}',100);
    INSERT INTO entities VALUES ('original-id','Document','{"title":"Report"}',7,100,200);`);
  legacy.close();
  const original = fs.readFileSync(dbFile);
  fs.mkdirSync(path.join(f.sourceDir, 'runs')); fs.writeFileSync(path.join(f.sourceDir, 'runs', 'unknown-history.jsonl'), '{"event":"custom"}\n');
  const report = await migrateDataCopy({ ...f, steps: [{ id: 'platform.entity-schema', version: 1, apply(dataDir) { const store = new EntityStore(path.join(dataDir, 'entities.db')); store.close(); } }] });
  assert.equal(report.status, 'completed'); assert.equal(report.backupComplete, true);
  assert.deepEqual(report.steps[0].changed, ['entities.db']);
  assert.deepEqual(fs.readFileSync(dbFile), original);
  assert.deepEqual(fs.readFileSync(path.join(f.bundleDir, 'backup', 'entities.db')), original);
  const store = new EntityStore(path.join(f.bundleDir, 'data', 'entities.db'));
  assert.equal(store.getEntity('original-id').version, 7); assert.equal(store.getEntity('original-id').data.title, 'Report'); store.close();
  const db = new Database(path.join(f.bundleDir, 'data', 'entities.db'));
  assert.equal(db.prepare('SELECT value FROM customer_extension').get().value, 'keep'); db.close();
  assert.equal(fs.readFileSync(path.join(f.bundleDir, 'data', 'runs', 'unknown-history.jsonl'), 'utf8'), '{"event":"custom"}\n');
  assert.equal(JSON.stringify(report).includes('test-secret'), false);
  assert.equal(fs.statSync(f.bundleDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.bundleDir, 'report.json')).mode & 0o777, 0o600);
});

test('failed steps retain backup and partial copy, redact thrown values, and restore only to a fresh outside directory', async t => {
  const f = fixture(t);
  await assert.rejects(migrateDataCopy({ ...f, steps: [{ id: 'domain.sample', version: 2, apply(dir) { fs.writeFileSync(path.join(dir, 'config.json'), 'partial'); throw new Error('test-secret'); } }] }), /domain.sample failed/);
  const report = readReport(f); assert.equal(report.status, 'failed'); assert.equal(report.steps[0].status, 'failed');
  assert.equal(JSON.stringify(report).includes('test-secret'), false);
  const restored = path.join(f.root, 'restored'); restoreMigrationBackup(f.bundleDir, restored);
  assert.deepEqual(fs.readFileSync(path.join(restored, 'config.json')), fs.readFileSync(path.join(f.sourceDir, 'config.json')));
  assert.throws(() => restoreMigrationBackup(f.bundleDir, restored), /already exist/);
  assert.throws(() => restoreMigrationBackup(f.bundleDir, path.join(f.sourceDir, 'inside')), /outside/);
  assert.throws(() => restoreMigrationBackup(f.bundleDir, path.join(f.bundleDir, 'inside')), /outside/);
});

test('migration refuses pre-existing or source-nested destinations and duplicate migration identities', async t => {
  const f = fixture(t);
  await assert.rejects(migrateDataCopy({ ...f, bundleDir: f.sourceDir, steps: [] }), /outside/);
  await assert.rejects(migrateDataCopy({ ...f, bundleDir: path.join(f.sourceDir, 'inside'), steps: [] }), /outside/);
  await assert.rejects(migrateDataCopy({ ...f, steps: [{ id: 'same', version: 1, apply() {} }, { id: 'same', version: 2, apply() {} }] }), /unique/);
  assert.equal(fs.existsSync(f.bundleDir), false);
  fs.mkdirSync(f.bundleDir);
  await assert.rejects(migrateDataCopy({ ...f, steps: [] }), /already exist/);
});

test('source symlinks are reported without following external data', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(f.sourceDir, 'link'));
  await assert.rejects(migrateDataCopy({ ...f, steps: [] }), /symlink or special/);
  assert.equal(readReport(f).backupComplete, false);
  assert.equal(fs.existsSync(path.join(f.bundleDir, 'backup', 'link')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
});

test('source changes during migration invalidate the copy without overwriting the newer original', async t => {
  const f = fixture(t);
  await assert.rejects(migrateDataCopy({ ...f, steps: [{ id: 'fixture.concurrent-writer', version: 1, apply() { fs.writeFileSync(path.join(f.sourceDir, 'new.txt'), 'external update'); } }] }), /Source changed/);
  assert.equal(readReport(f).failure.code, 'source_changed');
  assert.equal(fs.readFileSync(path.join(f.sourceDir, 'new.txt'), 'utf8'), 'external update');
  assert.equal(fs.existsSync(path.join(f.bundleDir, 'backup', 'new.txt')), false);
});

test('pending/running step receipts are persisted before effects and are not blindly resumed', async t => {
  const f = fixture(t); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const operation = migrateDataCopy({ ...f, steps: [{ id: 'platform.wait', version: 1, async apply() { entered(); await new Promise(resolve => { release = resolve; }); } }] });
  await ready;
  assert.equal(readReport(f).steps[0].status, 'running');
  await assert.rejects(migrateDataCopy({ ...f, steps: [] }), /already exist/);
  release(); await operation;
  assert.equal(readReport(f).steps[0].status, 'completed');
});

test('changed backup is not restored and an incomplete backup is not treated as recoverable', async t => {
  const f = fixture(t); await migrateDataCopy({ ...f, steps: [] });
  fs.writeFileSync(path.join(f.bundleDir, 'backup', 'config.json'), 'tampered');
  const restored = path.join(f.root, 'restored');
  assert.throws(() => restoreMigrationBackup(f.bundleDir, restored), /does not match/);
  assert.equal(fs.existsSync(restored), false);
  const report = readReport(f); report.backupComplete = false; fs.writeFileSync(path.join(f.bundleDir, 'report.json'), JSON.stringify(report));
  assert.throws(() => restoreMigrationBackup(f.bundleDir, restored), /no verified complete backup/);
});

test('legacy Brain directory migration only changes the backed-up working copy and refuses collisions', async t => {
  const f = fixture(t), old = path.join(f.sourceDir, 'intents', 'dev', 'research.reports');
  fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'report.itt.json'), '{"version":2}');
  assert.deepEqual(planBrainDirectoryMigration(f.sourceDir), [{ from: 'intents/dev/research.reports', to: 'intents/dev/research/reports' }]);
  const report = await migrateBrainDirectoriesCopy(f); assert.equal(report.status, 'completed');
  assert.equal(fs.existsSync(old), true);
  assert.equal(fs.existsSync(path.join(f.bundleDir, 'backup', 'intents', 'dev', 'research.reports')), true);
  assert.equal(fs.readFileSync(path.join(f.bundleDir, 'data', 'intents', 'dev', 'research', 'reports', 'report.itt.json'), 'utf8'), '{"version":2}');
  fs.mkdirSync(path.join(f.sourceDir, 'intents', 'dev', 'research', 'reports'), { recursive: true });
  assert.throws(() => planBrainDirectoryMigration(f.sourceDir), /destination already exists/);
});

test('CLI requires explicit paths and independently restores a completed backup', async t => {
  const f = fixture(t), cli = require.resolve('@openhilo/platform-services/data-migration-cli');
  assert.throws(() => execFileSync(process.execPath, [cli, 'plan-brain'], { stdio: 'pipe' }), /Command failed/);
  const output = JSON.parse(execFileSync(process.execPath, [cli, 'migrate-brain', '--source', f.sourceDir, '--bundle', f.bundleDir], { encoding: 'utf8' }));
  assert.equal(output.status, 'completed');
  const destination = path.join(f.root, 'restored');
  execFileSync(process.execPath, [cli, 'restore', '--bundle', f.bundleDir, '--destination', destination]);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'config.json')), fs.readFileSync(path.join(f.sourceDir, 'config.json')));
});

test('backup root links and symlinked nested destinations cannot bypass copy boundaries', async t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.sourceDir, alias);
  await assert.rejects(migrateDataCopy({ ...f, bundleDir: path.join(alias, 'nested'), steps: [] }), /outside/);
  await migrateDataCopy({ ...f, steps: [] });
  const backup = path.join(f.bundleDir, 'backup'), retained = path.join(f.root, 'retained');
  fs.renameSync(backup, retained); fs.symlinkSync(retained, backup);
  assert.throws(() => restoreMigrationBackup(f.bundleDir, path.join(f.root, 'restored')), /ordinary directories/);
});

test('plain copy CLI preserves layout and explicitly reports that it has not activated migrated data', t => {
  const f = fixture(t), cli = require.resolve('@openhilo/platform-services/data-migration-cli');
  const output = JSON.parse(execFileSync(process.execPath, [cli, 'copy', '--source', f.sourceDir, '--bundle', f.bundleDir], { encoding: 'utf8' }));
  assert.equal(output.activation, 'not_activated');
  assert.deepEqual(readReport(f).steps, []);
  assert.deepEqual(fs.readFileSync(path.join(f.bundleDir, 'data', 'config.json')), fs.readFileSync(path.join(f.sourceDir, 'config.json')));
});
