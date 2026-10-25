import { entityFieldMap } from '../entity-schema';

test('preserves field maps including named type and properties fields', () => {
  const fields = { type: 'text', properties: 'json', count: { type: 'number' } };
  expect(entityFieldMap(fields)).toBe(fields);
});

test.each([null, [], 'text', 4])('rejects non-object metadata %s instead of displaying an empty class', schema => {
  expect(() => entityFieldMap(schema)).toThrow('JSON object');
});

test.each([
  { type: 'object', properties: { count: { type: 'number' } } },
  { $schema: 'https://json-schema.org/draft-07/schema', properties: {} },
])('does not silently turn JSON Schema keywords into entity fields', schema => {
  expect(() => entityFieldMap(schema)).toThrow('field map');
  expect(schema.properties).toBeDefined();
});
