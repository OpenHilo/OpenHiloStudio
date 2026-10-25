const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { closure, licenseFiles } = require('../../scripts/lib/third-party.cjs');

test('notice dependency traversal includes required and present optional peers, nested versions and workspace targets', () => {
  const packages = {
    app: { dependencies: { library: '1', local: '1' }, peerDependencies: { optional: '1', absent: '1' }, peerDependenciesMeta: { optional: { optional: true }, absent: { optional: true } } },
    'node_modules/library': { version: '1', dependencies: { nested: '1' } },
    'node_modules/library/node_modules/nested': { version: '1' },
    'node_modules/nested': { version: '2' },
    'node_modules/local': { link: true, resolved: 'packages/local' },
    'packages/local': { dependencies: { nested: '2' } },
    'node_modules/optional': { version: '1' },
  };
  const result = closure(packages, ['app']);
  assert.deepEqual(result.keys, ['app', 'node_modules/library', 'node_modules/library/node_modules/nested', 'node_modules/nested', 'node_modules/optional', 'packages/local']);
  assert.deepEqual(result.absentOptional, [{ from: 'app', name: 'absent' }]);
  delete packages['node_modules/nested'];
  assert.throws(() => closure(packages, ['app']), /Unresolved required dependency nested/);
});

test('license discovery preserves nested vendored notices and excludes code, dependency trees and symlinks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-notices-'));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['LICENSE', 'ThirdPartyNotices.txt', 'src/vendor/NOTICE.md', 'LICENSE.js', 'node_modules/hidden/LICENSE']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'fixture');
  }
  fs.symlinkSync('src', path.join(root, 'linked'));
  assert.deepEqual(licenseFiles(root).sort(), ['LICENSE', 'ThirdPartyNotices.txt', 'src/vendor/NOTICE.md'].sort());
});

test('generation rejects missing notices, installed-version drift and changed upstream supplements', t => {
  const { generate } = require('../../scripts/lib/third-party.cjs');
  const crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-notice-generation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(file, contents) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof contents === 'string' ? contents : JSON.stringify(contents)); }
  write('package.json', { dependencies: { fixture: '1.0.0' } });
  write('platform/package.json', {});
  write('package-lock.json', { packages: { '': { dependencies: { fixture: '1.0.0' } }, 'node_modules/fixture': { version: '1.0.0', license: 'MIT', integrity: 'fixture-integrity' } } });
  write('platform/package-lock.json', { packages: { '': {} } });
  write('node_modules/fixture/package.json', { name: 'fixture', version: '1.0.0', license: 'MIT' });
  assert.throws(() => generate(root), /no license text/);
  write('node_modules/fixture/LICENSE', 'fixture license\n');
  const first = generate(root); assert.match(first.get('THIRD_PARTY_NOTICES.txt'), /fixture license/);
  assert.equal(first.get('docs/open-source/third-party-inventory.json'), generate(root).get('docs/open-source/third-party-inventory.json'));
  write('package.json', { dependencies: { fixture: '2.0.0' } });
  assert.throws(() => generate(root), /dependencies differs from lock/);
  write('package.json', { dependencies: { fixture: '1.0.0' } });
  write('node_modules/fixture/package.json', { name: 'fixture', version: '2.0.0' });
  assert.throws(() => generate(root), /installed version differs/);
  write('node_modules/fixture/package.json', { name: 'fixture', version: '1.0.0' });
  write('docs/open-source/third-party-sources/supplement.txt', 'upstream text');
  write('docs/open-source/third-party-sources/index.json', { 'fixture@1.0.0': [{ file: 'supplement.txt', url: 'https://example.invalid/pinned-license', sha256: crypto.createHash('sha256').update('upstream text').digest('hex') }] });
  assert.match(generate(root).get('THIRD_PARTY_NOTICES.txt'), /upstream text/);
  write('docs/open-source/third-party-sources/supplement.txt', 'changed text');
  assert.throws(() => generate(root), /upstream license hash changed/);
});
