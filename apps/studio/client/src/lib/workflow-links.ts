import {resolveIntentPrefill, resolveRetryIntent} from './intent-prefill';
export function workflowLibraryHref(run: {intent: string; ittPath?: string; run_id?: string}): string {
  const query = new URLSearchParams({intent: run.intent});
  if (run.ittPath) query.set('source', run.ittPath);
  if (run.run_id) query.set('fromRun', run.run_id);
  return `/intents?${query}`;
}
export function resolveWorkflowReference<T extends {name: string; ittPath: string; relativeIttPath?: string}>(items: T[], source?: string, hint?: string): T | undefined {
  return source ? resolveRetryIntent(items, source) : hint ? resolveIntentPrefill(items, hint) : undefined;
}
