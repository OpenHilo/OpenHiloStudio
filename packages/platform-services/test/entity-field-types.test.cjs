const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EntityStore } = require('../dist/entity-store');

test('entity field reads preserve JSON value types and CAS versions through updates', () => {
  const store = new EntityStore(':memory:');
  try {
    store.defineClass('QA', {}, 'typed field reads', {});
    const values = { object: { x: false }, array: [0, '', false, null], yes: true, no: false,
      zero: 0, empty: '', jsonText: '{"x":false}', nil: null };
    const { id } = store.createEntity('QA', 'types', values, 'typed test entity', {});
    for (const [key, value] of Object.entries(values)) {
      assert.deepEqual(store.getEntityField(id, '$.' + key), { value, entityVersion: 1 }, key);
    }
    store.updateEntityField(id, '$.object', { changed: true }, 1);
    assert.deepEqual(store.getEntityField(id, '$.object'), { value: { changed: true }, entityVersion: 2 });
    assert.deepEqual(store.getEntityField(id, '$.absent'), { value: null, entityVersion: 2 });
  } finally { store.close(); }
});
