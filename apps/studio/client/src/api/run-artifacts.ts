export interface RunSnapshot { nodes: Record<string, Record<string, unknown>>; entry: string; }
export interface NodeIo { error?: string; diagnostics?: {stdout?: string; stderr?: string; exitCode?: number; rawOutputs?: string; truncated?: boolean}; inputs: unknown; outputs: unknown; }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function decodeSnapshot(value: unknown): RunSnapshot {
  if (!record(value) || !record(value.nodes) || typeof value.entry !== 'string' ||
      Object.values(value.nodes).some(node => !record(node) || typeof node.type !== 'string' || typeof node.id !== 'string' || !node.id)) {
    throw new Error('The server returned an invalid workflow snapshot.');
  }
  return value as unknown as RunSnapshot;
}
export function decodeSource(value: unknown): string {
  if (!record(value) || typeof value.ts !== 'string') throw new Error('The server returned invalid source data.');
  return value.ts;
}
export function decodeNodeIo(value: unknown): NodeIo {
  if (!record(value) || !Object.prototype.hasOwnProperty.call(value, 'inputs') || !Object.prototype.hasOwnProperty.call(value, 'outputs')) {
    throw new Error('The server returned invalid node details.');
  }
  return { inputs: value.inputs, outputs: value.outputs, ...(typeof value.error === 'string' ? {error: value.error} : {}), ...(record(value.diagnostics) ? {diagnostics: value.diagnostics} : {}) };
}

/** Read-only requests have a deadline; connection failure is never reported as absent data. */
export async function readRunArtifact<T>(url: string, decode: (value: unknown) => T, signal: AbortSignal): Promise<T> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  let response: Response;
  try {
    response = await fetch(url, { signal: combined });
  } catch (error) {
    if (signal.aborted) throw error;
    if (combined.aborted) throw new Error('The server did not respond within 15 seconds. Try again.');
    throw new Error('Cannot reach the server. Check the connection and try again.');
  }
  if (!response.ok) {
    let detail = '';
    try {
      const body: unknown = await response.json();
      if (record(body)) {
        if (typeof body.message === 'string') detail = body.message;
        else if (typeof body.error === 'string') detail = body.error;
      }
    } catch { /* Keep the HTTP status. */ }
    throw new Error(`${detail || 'The server could not load this data'} (HTTP ${response.status}).`);
  }
  let value: unknown;
  try { value = await response.json(); }
  catch {
    if (signal.aborted) throw signal.reason;
    if (combined.aborted) throw new Error('The server did not respond within 15 seconds. Try again.');
    throw new Error('The server returned an unreadable response. Try again.');
  }
  return decode(value);
}
