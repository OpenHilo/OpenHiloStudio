const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileConfigStore, ConfigurationReadError } = require('@openhilo/platform-services/file-config');
const { createConfigurationService, ConfigurationInputError } = require('@openhilo/platform-services/configuration-service');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'configuration-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'config.json');
  const parse = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value.limit !== undefined && !Number.isInteger(value.limit))) throw new ConfigurationInputError('Invalid limit');
    return value;
  };
  return { directory, filePath, store: createFileConfigStore({ filePath, parse, defaults: () => ({ limit: 3 }) }) };
}

test('explicit storage preserves unrelated data and writes private complete JSON', t => {
  const { directory, filePath, store } = fixture(t);
  assert.throws(() => createFileConfigStore({ filePath: 'relative', parse: value => value, defaults: () => ({}) }), /absolute/);
  const initial = store.load(); initial.limit = 99;
  assert.equal(store.load().limit, 3);
  store.save({ secret: { token: 'fixture-only' } });
  assert.deepEqual(store.save({ limit: 7 }), { limit: 7, secret: { token: 'fixture-only' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), store.load());
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
  assert.throws(() => store.save({ limit: 'invalid' }), /Invalid limit/);
  assert.equal(store.load().limit, 7);
});

test('corrupt and unreadable files never substitute defaults or overwrite data', t => {
  const { filePath, store } = fixture(t);
  fs.writeFileSync(filePath, '{bad-json');
  assert.throws(() => store.load(), error => error instanceof ConfigurationReadError && error.reason === 'invalid_json');
  assert.throws(() => store.save({ limit: 4 }), /invalid/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{bad-json');
  fs.unlinkSync(filePath); fs.mkdirSync(filePath);
  assert.throws(() => store.load(), error => error instanceof ConfigurationReadError && error.reason === 'unreadable');
});

test('failed atomic replacement retains the last config and removes its temporary file', t => {
  const { directory, store } = fixture(t); store.save({ limit: 5 });
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('fixture rename failure'), { code: 'EIO' }); };
  try { assert.throws(() => store.save({ limit: 6 }), /fixture rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(store.load().limit, 5);
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('public service validates all fields before saving and never projects private fields', async t => {
  const { store } = fixture(t); store.save({ secret: { token: 'fixture-only' }, limit: 5 });
  let writes = 0;
  const service = createConfigurationService({ load: store.load, save: patch => { writes++; return store.save(patch); }, fields: {
    limit: async value => { if (!Number.isInteger(value)) throw new ConfigurationInputError('Invalid limit'); return value; },
  } });
  assert.deepEqual(await service.read(), { limit: 5 });
  assert.deepEqual(await service.update({ limit: 8 }), { limit: 8 });
  for (const input of [null, [], 4, { secret: 'must-not-echo' }, JSON.parse('{"__proto__":{"polluted":true}}'), { limit: 2, private: 'must-not-echo' }, { limit: 'invalid' }]) {
    await assert.rejects(service.update(input), error => error instanceof ConfigurationInputError && !error.message.includes('must-not-echo'));
  }
  assert.equal(writes, 1); assert.equal(store.load().limit, 8);
  assert.deepEqual(store.load().secret, { token: 'fixture-only' });
});

test('configuration subentries do not load application, native process, SDK or database modules', () => {
  const { spawnSync } = require('node:child_process');
  const script = `const Module = require('node:module'); const load = Module._load;
    Module._load = function(name, ...args) {
      if (/ai-claude-code|ai-sdk|@intentorch|better-sqlite3|node-pty|child_process/.test(name)) throw new Error('Forbidden dependency: ' + name);
      return load.call(this, name, ...args);
    };
    require('@openhilo/platform-services/file-config'); require('@openhilo/platform-services/configuration-service'); require('@openhilo/platform-services/deployment-config');`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('an invalid serialized envelope is rejected before replacing the previous config', t => {
  const { filePath, store } = fixture(t); store.save({ limit: 5 });
  const before = fs.readFileSync(filePath);
  const broken = createFileConfigStore({ filePath, defaults: () => ({ limit: 1 }),
    parse(value) { if (!value || typeof value.limit !== 'number') throw new Error('Invalid envelope'); return value; },
    serialize: () => null,
  });
  assert.throws(() => broken.save({ limit: 6 }), /Invalid envelope/);
  assert.deepEqual(fs.readFileSync(filePath), before);
});
