import type { HumanSubmission, HumanSubmissionReceipt } from '@openhilo/human-contracts';
// platform/client/src/api/human.ts
export interface HumanTodo { runId: string; intent: string; workdir: string; nodeId: string; taskId?: string; nodeRunId?: string; prompt: string; resolvedInputs: Record<string, string>; suspendedAt: string; outputs?: Array<{ name: string; kind: string }>; acceptedSubmission?: HumanSubmission; }
export interface HumanNodeDetail extends HumanTodo { nodeRunId?: string; outputs: Array<{ name: string; kind: string }>; acceptedSubmission?: HumanSubmission; }

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const deadline = AbortSignal.timeout(15000);
  try {
    const res = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
    if (!res.ok) throw await humanRequestError(res);
    return await res.json() as T;
  } catch (error) {
    if (error instanceof HumanRequestError || init.signal?.aborted) throw error;
    throw new Error(init.method
      ? 'The server did not confirm your answer. It may already have been saved. Check the run status or retry the same answer; do not submit a different answer.'
      : 'Unable to load the human task. Check the server connection and retry.');
  }
}

export async function getHumanTodos(signal?: AbortSignal): Promise<HumanTodo[]> {
  const todos = await request<HumanTodo[]>('/api/human-todos', { signal });
  if (!Array.isArray(todos)) throw new Error('Invalid pending human tasks received.');
  return todos;
}

export async function getHumanNode(runId: string): Promise<HumanNodeDetail> {
  return request(`/api/runs/${runId}/human-node`);
}

export class HumanRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function humanRequestError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null;
  const message = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : `Human task request failed (HTTP ${response.status})`;
  return new HumanRequestError(message, response.status);
}

export async function submitHumanTask(runId: string, humanSubmission: HumanSubmission): Promise<HumanSubmissionReceipt> {
  return request(`/api/runs/${runId}/human-node`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ humanSubmission }) });
}

export interface HumanHistoryItem {
  acceptedSubmission?: HumanSubmission;
  nodeRunId: string;
  taskId?: string;
  nodeId: string;
  prompt: string;
  resolvedInputs: Record<string, unknown>;
  outputTypes: Array<{ name: string; kind: string }>;
  result?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  status: 'completed' | 'suspended' | 'failed' | 'incomplete';
  error?: string;
  intent?: string;
  frameId?: string;
  attemptNodeRunIds?: string[];
}

export async function getHumanHistory(runId: string, signal?: AbortSignal): Promise<HumanHistoryItem[]> {
  return request(`/api/runs/${runId}/human-history`, { signal });
}
