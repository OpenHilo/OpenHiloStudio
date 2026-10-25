const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const publicCodec = require('@openhilo/platform-services/deployment-config');
const { toDeploymentConfig, parseDeploymentConfig, readCompatibleConfig, writeCompatibleConfig, migrateConfigurationCopy } = publicCodec.createDeploymentConfigCodec({
  domain: { id: 'example-app', fields: ['classifier'] },
  implementation: { id: 'example-adapter', fields: ['executable', 'access_mode', 'access_patterns', 'pool', 'meter', 'tool_server'] },
  defaultApplication: { id: 'example-app', version: 1 }, defaultExecution: { adapter: 'example-adapter' },
  fallbacks: { access_mode: { from: 'defaults.access_mode', archiveKey: 'dottedAccessMode' } },
});
const { createFileConfigStore } = require('@openhilo/platform-services/file-config');
const { restoreMigrationBackup } = require('@openhilo/platform-services/data-migration');
const sdk = { adapter: 'sdk', default_profile: 'main', profiles: { main: { provider: 'openai', model: 'offline', api_key_env: 'TEST_KEY_NOT_READ' } } };
const router = { base_url: 'https://unused.invalid', api_key: 'private-fixture-key', model: 'offline' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-config-')), sourceDir = path.join(root, 'source'), bundleDir = path.join(root, 'bundle');
  fs.mkdirSync(sourceDir); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, sourceDir, bundleDir };
}

test('separates domain and native AI settings while preserving unknown and inactive legacy wrapper values', () => {
  const original = { outer: { future: true }, executable: 'ignored-outer', defaults: {
    application: { id: 'generic', version: 1 }, ai_execution: sdk, executable: '/explicit/adapter', tool_server: '/explicit/mcp.js',
    classifier: router, meter: router, pool: { custom_future_option: true }, access_mode: null, 'defaults.access_mode': 'manual', custom: { a: 1 },
  } };
  const converted = toDeploymentConfig(original), view = readCompatibleConfig(converted);
  assert.deepEqual(converted.domain.selection, original.defaults.application);
  assert.deepEqual(converted.domain.applications['example-app'].classifier, router);
  assert.deepEqual(converted.ai.execution, sdk);
  assert.deepEqual(converted.ai.implementations['example-adapter'].meter, router);
  assert.equal(converted.legacy.dottedAccessMode, 'manual');
  assert.equal(view.access_mode, 'manual'); assert.equal(view.executable, '/explicit/adapter');
  assert.equal(view.tool_server, '/explicit/mcp.js'); assert.deepEqual(view.custom, { a: 1 });
  assert.deepEqual(converted.legacy.wrapper, { outer: { future: true }, executable: 'ignored-outer' });
  converted.ai.execution.profiles.main.model = 'changed'; assert.equal(original.defaults.ai_execution.profiles.main.model, 'offline');
});

test('legacy defaults become explicit selections; envelope migration is idempotent and future formats fail closed', () => {
  const converted = toDeploymentConfig({});
  assert.deepEqual(converted.domain.selection, { id: 'example-app', version: 1 });
  assert.deepEqual(converted.ai.execution, { adapter: 'example-adapter' });
  assert.deepEqual(toDeploymentConfig(converted), converted);
  assert.throws(() => toDeploymentConfig({ ...converted, version: 2 }), /unsupported/);
  assert.throws(() => readCompatibleConfig({ format: 'intentorch.future' }), /unsupported/);
  assert.throws(() => parseDeploymentConfig({ ...converted, ai: null }), /ai must be a JSON object/);
  assert.throws(() => toDeploymentConfig({ ai_execution: null }), /AI execution/);
});

test('namespace-aware writes change only explicit fields and preserve other applications/adapters and private values', () => {
  const converted = toDeploymentConfig({ application: { id: 'generic', version: 1 }, ai_execution: sdk, classifier: router, custom: true });
  converted.domain.applications.external = { setting: 'keep' };
  converted.ai.implementations.external = { secret: 'keep-private' };
  converted.core.paths = { home: '/explicit/original' };
  converted.future = { preserve: true };
  const updated = writeCompatibleConfig(converted, { ...readCompatibleConfig(converted), access_mode: 'manual', classifier: undefined }, { access_mode: 'manual' });
  assert.equal(updated.ai.implementations['example-adapter'].access_mode, 'manual');
  assert.deepEqual(updated.domain.applications['example-app'].classifier, router);
  assert.deepEqual(updated.domain.applications.external, converted.domain.applications.external);
  assert.deepEqual(updated.ai.implementations.external, converted.ai.implementations.external);
  assert.deepEqual(updated.core.paths, converted.core.paths); assert.deepEqual(updated.future, converted.future);
  assert.equal(converted.ai.implementations['example-adapter'].access_mode, undefined);
  const cleared = writeCompatibleConfig(updated, { ...readCompatibleConfig(updated), ai_execution: undefined }, { ai_execution: undefined });
  assert.deepEqual(cleared.ai.execution, { adapter: 'example-adapter' });
});

test('file store serialization preserves envelope across reads and writes without leaking a storage representation to the caller', t => {
  const f = fixture(t), filePath = path.join(f.sourceDir, 'config.json');
  const original = toDeploymentConfig({ application: { id: 'generic', version: 1 }, ai_execution: sdk, classifier: router });
  fs.writeFileSync(filePath, JSON.stringify(original));
  const store = createFileConfigStore({ filePath, defaults: () => ({}), parse: readCompatibleConfig,
    serialize: (updated, raw, patch) => writeCompatibleConfig(raw, updated, patch) });
  const returned = store.save({ access_mode: 'manual' });
  assert.equal(returned.format, undefined); assert.equal(returned.access_mode, 'manual');
  assert.equal(JSON.parse(fs.readFileSync(filePath)).format, 'intentorch.deployment');
  assert.deepEqual(store.load().ai_execution, sdk); assert.deepEqual(store.load().classifier, router);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('flat and defaults-wrapped compatibility writes retain unknown fields and existing layout', () => {
  const flat = { executable: 'original', unknown: { keep: true } };
  const normalized = { executable: 'updated', access_mode: 'auto' };
  assert.deepEqual(writeCompatibleConfig(flat, normalized, normalized), { ...normalized, unknown: { keep: true } });
  const wrapped = { keep: 'outer', defaults: flat };
  assert.deepEqual(writeCompatibleConfig(wrapped, normalized, normalized), { keep: 'outer', defaults: { ...normalized, unknown: { keep: true } } });
});

test('configuration CLI migrates only its working copy, preserves paths/secrets, and supports verified backup restoration', async t => {
  const f = fixture(t), file = path.join(f.sourceDir, 'config.json');
  const source = JSON.stringify({ defaults: { application: { id: 'generic', version: 1 }, ai_execution: sdk, classifier: router, executable: '/original/native-path' } });
  fs.writeFileSync(file, source);
  const cli = require.resolve('@openhilo/platform-services/data-migration-cli');
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'migrate-config', '--source', f.sourceDir, '--bundle', f.bundleDir], { encoding: 'utf8' }));
  assert.equal(result.activation, 'not_activated'); assert.equal(fs.readFileSync(file, 'utf8'), source);
  const converted = JSON.parse(fs.readFileSync(path.join(f.bundleDir, 'data', 'config.json')));
  assert.deepEqual(publicCodec.readCompatibleConfig(converted).ai_execution, sdk);
  assert.equal(publicCodec.readCompatibleConfig(converted).executable, '/original/native-path');
  assert.equal(publicCodec.readCompatibleConfig(converted).classifier.api_key, 'private-fixture-key');
  const report = fs.readFileSync(path.join(f.bundleDir, 'report.json'), 'utf8');
  assert.equal(report.includes('private-fixture-key'), false); assert.equal(report.includes('/original/native-path'), false);
  const restore = path.join(f.root, 'restored'); restoreMigrationBackup(f.bundleDir, restore);
  assert.equal(fs.readFileSync(path.join(restore, 'config.json'), 'utf8'), source);
});

test('malformed configuration migration fails without creating a default provider or changing source/backup', async t => {
  const f = fixture(t), file = path.join(f.sourceDir, 'config.json'); fs.writeFileSync(file, '{"secret":"private-fixture-key"');
  await assert.rejects(migrateConfigurationCopy(f), /step platform.configuration-namespaces failed/);
  assert.equal(fs.readFileSync(path.join(f.bundleDir, 'backup', 'config.json'), 'utf8'), fs.readFileSync(file, 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bundleDir, 'report.json'))).status, 'failed');
});

test('retained unknown fields cannot override settings owned by a domain or AI namespace', () => {
  const converted = toDeploymentConfig({}); converted.core.legacyFields.executable = '/wrong-namespace';
  assert.throws(() => readCompatibleConfig(converted), /duplicate a domain or AI setting/);
});

test('public codec never infers an application or provider and retains unknown fields', () => {
  assert.throws(() => publicCodec.toDeploymentConfig({}), /application must be selected explicitly/);
  assert.throws(() => publicCodec.toDeploymentConfig({ application: { id: 'generic' } }), /AI execution must be selected explicitly/);
  const raw = { application: { id: 'generic', version: 1 }, ai_execution: sdk, classifier: { private: true } };
  const converted = publicCodec.toDeploymentConfig(raw);
  assert.deepEqual(converted.domain.applications, {});
  assert.deepEqual(converted.ai.implementations, {});
  assert.deepEqual(publicCodec.readCompatibleConfig(converted), raw);
  assert.throws(() => publicCodec.writeCompatibleConfig(converted, { ...raw, application: undefined }, { application: undefined }), /explicitly/);
  for (const field of ['applications', 'implementations']) {
    const bad = structuredClone(converted);
    (field === 'applications' ? bad.domain : bad.ai)[field].example = null;
    assert.throws(() => publicCodec.parseDeploymentConfig(bad), /must be a JSON object/);
  }
});

test('compatibility policies reject ambiguous ownership and unsafe field mappings', () => {
  assert.throws(() => publicCodec.createDeploymentConfigCodec({ domain: { id: 'app', fields: ['application'] } }), /unique owners/);
  assert.throws(() => publicCodec.createDeploymentConfigCodec({ implementation: { id: 'adapter', fields: ['__proto__'] } }), /invalid compatibility field/);
  assert.throws(() => publicCodec.createDeploymentConfigCodec({ domain: { id: 'constructor', fields: [] } }), /invalid compatibility namespace/);
  assert.throws(() => publicCodec.createDeploymentConfigCodec({ fallbacks: { missing: { from: 'old', archiveKey: 'kept' } } }), /owned field/);
});
