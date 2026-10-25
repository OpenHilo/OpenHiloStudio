const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { EntityStore } = require('../dist/entity-store');
const { EntityService } = require('../dist/entity-service');

for (const corrupt of ['{"broken":', 'null', '[]', '{"n":1e999}']) {
  test(`entity list isolates unreadable fields (${corrupt}) without changing their bytes`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-corruption-'));
    const file = path.join(dir, 'entities.db');
    const store = new EntityStore(file); const raw = new Database(file);
    try {
      store.defineClass('QA', {}, 'test', {});
      const good = store.createEntity('QA', 'good', { n: 0, text: '', flag: false }, 'good', {});
      const bad = store.createEntity('QA', 'bad', { n: 1 }, 'bad', {});
      raw.prepare('UPDATE entities SET data=? WHERE id=?').run(corrupt, bad.id);
      const list = new EntityService(store).listEntities('QA');
      assert.equal(list.length, 2);
      assert.deepEqual(list.find(row => row.id === good.id).data, { n: 0, text: '', flag: false });
      const broken = list.find(row => row.id === bad.id);
      assert.equal(broken.data, null);
      assert.match(broken.readError, new RegExp(bad.id));
      assert.throws(() => store.getEntity(bad.id), /unreadable/i);
      assert.throws(() => store.updateEntityFields(bad.id, { n: 9 }), /unreadable/i);
      assert.equal(raw.prepare('SELECT data FROM entities WHERE id=?').get(bad.id).data, corrupt);
    } finally { raw.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('unreadable class schema identifies the class without touching it or hiding healthy classes', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'intentorch-class-corruption-'));
  const file=path.join(dir,'entities.db'); const store=new EntityStore(file); const raw=new Database(file);
  try {
    store.defineClass('Good', {}, 'good', {}); store.defineClass('Bad', {}, 'bad', {});
    raw.prepare('UPDATE classes SET schema=? WHERE name=?').run('{broken', 'Bad');
    assert.equal(new EntityService(store).listClasses().length,2);
    assert.deepEqual(store.queryClassInfo('Good').schema,{});
    assert.throws(()=>store.queryClassInfo('Bad'),/Class 'Bad'.*unreadable/);
    assert.equal(raw.prepare('SELECT schema FROM classes WHERE name=?').get('Bad').schema,'{broken');
  } finally {raw.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
