// platform/client/src/api/filters.ts
import { readRunArtifact } from './run-artifacts';
export interface SavedFilter { id: string; name: string; conditions: Record<string, unknown>; }

export async function listFilters(signal = new AbortController().signal): Promise<SavedFilter[]> {
  return readRunArtifact('/api/filters', value => value as SavedFilter[], signal);
}

export async function createFilter(body: { name: string; conditions: Record<string, unknown> }): Promise<SavedFilter> {
  const res = await fetch('/api/filters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<SavedFilter>;
}

export async function deleteFilter(id: string): Promise<void> {
  const res = await fetch(`/api/filters/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}
