import { classFieldsToSchema, schemaToClassFields, parseClassSchema, validateClassFields } from '../class-fields';

test('serializes selected types without losing special field names', () => {
  const result = classFieldsToSchema([
    { name: ' title ', type: 'text' }, { name: 'count', type: 'number' },
    { name: 'active', type: 'boolean' }, { name: '__proto__', type: 'json' },
  ]);
  expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse('{"title":"text","count":"number","active":"boolean","__proto__":"json"}'));
  expect(classFieldsToSchema([])).toEqual({});
});

test('rejects blank and duplicate names before serializing instead of overwriting fields', () => {
  const rows = [{ name: ' count ', type: 'number' }, { name: 'count', type: 'text' }, { name: ' ', type: 'text' }];
  expect(validateClassFields(rows).every(Boolean)).toBe(true);
  expect(() => classFieldsToSchema(rows)).toThrow();
});

test('simple schemas round trip; metadata and unsupported types never convert with data loss', () => {
  const rows = schemaToClassFields({ title: 'text', count: 'number', active: 'boolean', meta: 'json' });
  expect(rows).not.toBeNull();
  expect(classFieldsToSchema(rows!)).toEqual({ title: 'text', count: 'number', active: 'boolean', meta: 'json' });
  for (const schema of [{ count: { type: 'number', min: 0 } }, { count: 'integer' }, { extra: null }]) {
    expect(schemaToClassFields(schema)).toBeNull();
    expect(parseClassSchema(JSON.stringify(schema))).toEqual(schema);
  }
});

test.each(['[]', 'null', '{', '{"x":1e999}', '{"x":-0}', '{"$schema":"custom"}'])('invalid advanced schema cannot be submitted: %s', raw => {
  expect(() => parseClassSchema(raw)).toThrow();
});

test('table cannot create a schema the existing field-map reader rejects', () => {
  expect(() => classFieldsToSchema([{ name: '$schema', type: 'text' }])).toThrow();
});
