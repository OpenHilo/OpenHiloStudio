// Check committed package metadata; --pack also verifies the actual npm archive contents.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
const folders = ['packages', 'adapters', 'apps'].flatMap(group => fs.readdirSync(path.join(root, group)).map(name => path.join(group, name)))
  .filter(dir => fs.existsSync(path.join(root, dir, 'package.json'))).sort();
const temporary = process.argv.includes('--pack') ? fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-package-check-')) : undefined;
try {
  const names = new Set();
  for (const folder of folders) {
    const dir = path.join(root, folder), manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    assert.ok(manifest.name.startsWith('@openhilo/')); assert.ok(!names.has(manifest.name)); names.add(manifest.name);
    assert.equal(manifest.license, 'MIT', `${folder}: license metadata`);
    assert.equal(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), license, `${folder}: license text`);
    assert.ok(fs.existsSync(path.join(dir, 'README.md')), `${folder}: README`);
    assert.ok(fs.existsSync(path.join(dir, 'THIRD_PARTY_NOTICES.txt')), `${folder}: third-party notices`);
    assert.equal(manifest.private, true, `${folder}: release remains explicit`);
    if (temporary) {
      const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--cache', path.join(temporary, 'cache'), '--pack-destination', temporary], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      const files = new Set(packed.files.map(file => file.path));
      for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.md', 'package.json', manifest.main, manifest.types].filter(Boolean)) assert.ok(files.has(file.replace(/^\.\//, '')), `${manifest.name}: archive missing ${file}`);
      if (manifest.name === '@openhilo/studio') {
        assert.ok(files.has('THIRD_PARTY_NOTICES.html'), 'Studio archive missing UTF-8 browser notices');
        assert.ok([...files].some(file => /^dist\/client\/assets\/THIRD_PARTY_NOTICES-.+\.html$/.test(file)), 'Studio assets missing browser notices');
      }
      for (const file of files) assert.ok(!/(^|\/)(node_modules|\.env|\.git)(\/|$)/.test(file), `${manifest.name}: unintended archive entry`);
    }
    console.log(`checked ${manifest.name}${temporary ? ' archive' : ''}`);
  }
} finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
