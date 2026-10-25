/**
 * Normalize legacy frontend payloads to current SessionInput contract.
 * Keeps server-side API robust if a stale client bundle still sends old fields.
 */
export function normalizeTranslateInput(body: unknown): unknown {
  const raw = body as Record<string, unknown>;
  if (raw?.type === 'save_path') {
    return {
      type: 'save',
      path: String(raw.filePath ?? ''),
    };
  }
  return body;
}
