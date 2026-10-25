import { entityFieldMap } from './entity-schema';

export const classFieldTypes = ['text', 'number', 'boolean', 'json'] as const;
export interface ClassField { name: string; type: string }

export function validateClassFields(fields: ClassField[]): string[] {
  const names = fields.map(field => field.name.trim());
  return fields.map((field, index) => {
    const name = names[index];
    if (!name) return 'Enter a field name.';
    if (name === '$schema') return 'This name is reserved for JSON Schema. Choose another name.';
    if (names.filter(candidate => candidate === name).length > 1) return 'Field names must be unique.';
    if (!classFieldTypes.some(type => type === field.type)) return 'Choose a supported field type.';
    return '';
  });
}

export function classFieldsToSchema(fields: ClassField[]): Record<string, unknown> {
  const error = validateClassFields(fields).find(Boolean);
  if (error) throw new Error(error);
  return entityFieldMap(Object.fromEntries(fields.map(field => [field.name.trim(), field.type])));
}

/** Refuse any conversion that would discard metadata or normalize existing keys/types. */
export function schemaToClassFields(schema: Record<string, unknown>): ClassField[] | null {
  if (Object.entries(schema).some(([name, type]) => !name.trim() || name !== name.trim() ||
    !classFieldTypes.some(candidate => candidate === type))) return null;
  const fields = Object.entries(schema).map(([name, type]) => ({ name, type: type as string }));
  return validateClassFields(fields).some(Boolean) ? null : fields;
}

export function parseClassSchema(raw: string): Record<string, unknown> {
  const schema: unknown = JSON.parse(raw, (_key, value: unknown) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) throw new Error('Invalid JSON number');
    return value;
  });
  return entityFieldMap(schema);
}
