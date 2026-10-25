import { readRunArtifact } from './run-artifacts';
import type { RunInputEncoding } from '@openhilo/itt-contracts/run-inputs';
// platform/client/src/api/runs.ts
export interface PlatformRun {
  run_id: string; intent: string; workflowName?: string; workdir: string;
  resumeFailure?: {nodeRunId: string; reason?: string};
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'suspended';
  created_at: string; updated_at: string;
  ittPath?: string; inputs?: Record<string, string>; inputEncoding?: RunInputEncoding;
  triggeredBy?: 'manual' | 'schedule'; orphaned?: boolean;
  failReason?: string;
  workerActive?: boolean;
  stopping?: { requestedAt: string; error?: string };
}

export interface ListRunsResponse { runs: PlatformRun[]; total: number; page: number; limit: number; unreadable?: { path: string; error: string }[]; }

export async function listRuns(params: Record<string, string | number | undefined> = {}, signal: AbortSignal = new AbortController().signal): Promise<ListRunsResponse> {
  const q = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]): [string, string] => [k, String(v)])
  );
  return readRunArtifact(`/api/runs?${q}`, value => value as ListRunsResponse, signal);
}

export class RunReadError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'RunReadError'; }
}

export async function getRun(id: string, tailEvents = 0, signal?: AbortSignal): Promise<PlatformRun & { events: unknown[] }> {
  // Detail/graph views need every iteration and the original root frame. The
  // server defaults to a 200-event tail; explicit zero requests the full trace.
  const q = `?tailEvents=${tailEvents}`;
  const res = await fetch(`/api/runs/${id}${q}`, { signal });
  if (!res.ok) {
    let message = `Could not load run (HTTP ${res.status})`;
    try { const body = await res.json() as { error?: unknown } | null; if (typeof body?.error === 'string') message = body.error; } catch { /* Keep the HTTP status. */ }
    throw new RunReadError(message, res.status);
  }
  return res.json() as Promise<PlatformRun & { events: unknown[] }>;
}

export async function startRun(body: { ittPath: string; workdir: string; inputs?: Record<string, string>; inputEncoding?: RunInputEncoding; suspend?: boolean; triggeredBy?: string }): Promise<{ runId: string }> {
  const res = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let message = `Could not start run (HTTP ${res.status})`;
    try {
      const error = await res.json() as { message?: unknown; error?: unknown } | null;
      if (typeof error?.message === 'string') message = error.message;
      else if (typeof error?.error === 'string') message = error.error;
    } catch { /* Keep a readable HTTP error for non-JSON failures. */ }
    throw new Error(message);
  }
  return res.json() as Promise<{ runId: string }>;
}

export async function resumeRun(id: string, humanOutput?: Record<string, string>, retryFailedNode?: string): Promise<{ runId: string }> {
  const res = await fetch(`/api/runs/${id}/resume`, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ humanOutput, retryFailedNode }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ runId: string }>;
}

export async function abortRun(id: string): Promise<void> {
  const res = await fetch(`/api/runs/${id}/abort`, { method: 'POST', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(await res.text());
}

export async function suggestWorkdir(intent: string, signal: AbortSignal = new AbortController().signal): Promise<string> {
  return readRunArtifact(`/api/runs/suggest-workdir?intent=${encodeURIComponent(intent)}`, value => {
    if (!value || typeof value !== 'object' || !('workdir' in value) || typeof value.workdir !== 'string') {
      throw new Error('The server returned an invalid working directory. Try again.');
    }
    return value.workdir;
  }, signal);
}
