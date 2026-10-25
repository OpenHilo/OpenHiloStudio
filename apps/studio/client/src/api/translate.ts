import { createClientId } from '../lib/client-id';
// platform/client/src/api/translate.ts
import type { AiHealth } from './aiHealth';
import { readRunArtifact } from './run-artifacts';

// Must stay in sync with src/executor/ai/mcp-types.ts QuestionOption
// (client cannot import from server-side src/)
export interface QuestionOption {
  label: string;
  value: string;
  recommended?: boolean;
  reason?: string;
}

export type SessionStep = (
  | { phase: 'cc_running'; round: number; maxRounds: number }
  | { phase: 'cc_waiting_for_answer'; questionId: string; question: string; options?: QuestionOption[] }
  | { phase: 'auto_fixing'; fixAttempt: number; lastError: string }
  | { phase: 'confirm_merge'; preflight: { added: string[]; modified: string[]; deleted: string[]; diffs: Record<string, string>; contents: Record<string, string> }; entries: string[]; reviewId?: string }
  | { phase: 'done'; savedPath: string; savedPaths?: string[]; entries?: string[] }
  | { phase: 'error'; message: string; retryable: boolean; blockingSessionIds?: string[] }) & { revisionRequests?: Array<{reviewId:string;message:string}>; aiOutput?: string; aiHealth?: AiHealth; naturalLanguage?: string; answers?: Record<string, string>; answerHistory?: Array<{ questionId?: string; question: string; answer: string }> };

export interface GenerationSummary {
  sessionId: string;
  naturalLanguage: string;
  phase: SessionStep['phase'] | 'unavailable';
  updatedAt: string;
  published?: boolean;
  canDelete?: boolean;
}

async function readResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: unknown; error?: unknown } | null;
    const message = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : `Generation request failed (HTTP ${res.status})`;
    throw new Error(message);
  }
  return await res.json() as T;
}

export type GenerationGroup = 'attention' | 'active' | 'published' | 'ended' | 'error';
export interface GenerationList { sessions: GenerationSummary[]; total: number; allTotal?: number; counts?: Record<GenerationGroup, number> }
export async function listTranslations(offset = 0, signal?: AbortSignal, options?: { group: GenerationGroup | 'recent'; limit: number }): Promise<GenerationList> {
  const res = await fetch(`/api/translate?offset=${offset}&limit=${options?.limit ?? 20}${options ? `&group=${options.group}` : ''}`, { signal });
  return readResponse(res);
}

export async function restoreTranslationHistory(id: string): Promise<void> {
  await readResponse(await fetch(`/api/translate/${encodeURIComponent(id)}/restore-history`, { method: 'POST', signal: AbortSignal.timeout(15000) }));
}
export async function deleteTranslationHistory(id: string): Promise<void> {
  await readResponse(await fetch(`/api/translate/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) }));
}

const START_RECEIPT_KEY = 'intentorch.translate.pending-start';
let pendingStart: { fingerprint: string; requestId: string } | null = null;

/** Only the still-active form may acknowledge a delivered receipt. */
export function acknowledgeTranslateStart(requestId: string): void {
  if (pendingStart?.requestId === requestId) pendingStart = null;
  try {
    if (JSON.parse(sessionStorage.getItem(START_RECEIPT_KEY) ?? 'null')?.requestId === requestId) sessionStorage.removeItem(START_RECEIPT_KEY);
  } catch { /* Receipt acknowledgement remains usable without tab storage. */ }
}

export async function startTranslate(naturalLanguage: string, workspace?: string): Promise<{ sessionId: string; step: SessionStep }> {
  const fingerprint = JSON.stringify([naturalLanguage, workspace ?? null]);
  try {
    const saved = JSON.parse(sessionStorage.getItem(START_RECEIPT_KEY) ?? 'null');
    if (saved?.fingerprint === fingerprint && typeof saved.requestId === 'string') pendingStart = saved;
  } catch { /* The in-memory receipt still protects retries when tab storage is unavailable. */ }
  if (pendingStart?.fingerprint !== fingerprint) pendingStart = { fingerprint, requestId: createClientId() };
  const requestId = pendingStart.requestId;
  try { sessionStorage.setItem(START_RECEIPT_KEY, JSON.stringify(pendingStart)); } catch { /* Draft UI explains unavailable tab storage. */ }
  try {
    const res = await fetch('/api/translate/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ naturalLanguage, workspace, requestId }) });
    const result = await readResponse<{ sessionId: string; step: SessionStep }>(res);
    if (result.sessionId !== requestId) throw new Error('The server returned an unexpected creation receipt');
    return result;
  } catch (error) {
    throw new Error(`Task creation could not be confirmed. Check Generation history, or retry this same request to recover it without creating another task. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type SessionInput =
  | { type: 'start'; naturalLanguage: string; workspace?: string }
  | { type: 'merge_approve'; reviewId?: string }
  | { type: 'merge_reject' }
  | { type: 'feedback'; reviewId: string; message: string }
  | { type: 'retry' }
  | { type: 'mcp_answer'; questionId: string; answer: string };

export async function respondTranslate(sid: string, input: SessionInput): Promise<SessionStep> {
  const res = await fetch(`/api/translate/${sid}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  return readResponse(res);
}

export async function pollTranslate(sid: string, signal: AbortSignal = new AbortController().signal): Promise<SessionStep> {
  return readRunArtifact(`/api/translate/${sid}`, value => value as SessionStep, signal);
}

export async function stopTranslate(id: string): Promise<SessionStep> {
  return readResponse(await fetch(`/api/translate/${encodeURIComponent(id)}/stop`, { method: 'POST' }));
}
