/** Studio edits field maps; the generic store preserves arbitrary class metadata. */
export function entityFieldMap(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Field definitions must be a JSON object.');
  const value = schema as Record<string, unknown>;
  if (typeof value.$schema === 'string' || (value.type === 'object' && value.properties && typeof value.properties === 'object')) {
    throw new Error('Studio uses a field map, not a JSON Schema document. Use {"title":"text","count":"number","active":"boolean","metadata":"json"}. Existing class definitions are not changed.');
  }
  return value;
}
