const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Snapshotter } = require('../dist/brain-snapshot');

for (const layout of ['legacy', 'qualified']) test(`source snapshots retain exact published bytes (${layout})`, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-source-snapshot-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = 'export async function greet() { return { message: "你好🌱" }; }';
  const hash = createHash('sha256').update(source).digest('hex');
  const write = (file, value) => { const target = path.join(home, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return target; };
  const sourceFile = layout === 'qualified' ? 'team/module.ts' : 'team/greet.ts';
  write(`brain/${sourceFile}`, source);
  const metadata = { name: 'greet', namespace: 'team', entry: 'END', nodes: {}, sourceTs: `sha256:${hash}`, ...(layout === 'qualified' ? { sourceFile } : {}) };
  const entryFile = write('intents/team/greet/greet.itt.impl.json', JSON.stringify(metadata));
  const collect = name => { const snapshotDir = path.join(home, name); fs.mkdirSync(snapshotDir); new Snapshotter({ ittHome: home, entryFile, snapshotDir, layout }).collect(); return snapshotDir; };
  const first = collect('run-one');
  assert.equal(fs.readFileSync(path.join(first, '.sources', `${hash}.ts`), 'utf8'), source);
  write(`brain/${sourceFile}`, '// newer source');
  const second = collect('run-two');
  assert.equal(fs.existsSync(path.join(second, '.sources')), false);
  assert.equal(fs.readFileSync(path.join(first, '.sources', `${hash}.ts`), 'utf8'), source);
  // A metadata path or symlink outside Brain cannot smuggle a file into a run.
  write('outside.ts', source);
  write('intents/team/greet/greet.itt.impl.json', JSON.stringify({ ...metadata, sourceFile: '../outside.ts' }));
  assert.equal(fs.existsSync(path.join(collect('run-traversal'), '.sources')), false);
  fs.symlinkSync(path.join(home, 'outside.ts'), path.join(home, 'brain', 'escape.ts'));
  write('intents/team/greet/greet.itt.impl.json', JSON.stringify({ ...metadata, sourceFile: 'escape.ts' }));
  assert.equal(fs.existsSync(path.join(collect('run-symlink'), '.sources')), false);
});
