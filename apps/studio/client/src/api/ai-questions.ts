import { readRunArtifact } from './run-artifacts';

export interface AiQuestionKey { taskId: string; attemptId: string; questionId: string }
export interface AiQuestionItem extends AiQuestionKey {
  instruction: string;
  question: { id: string; prompt: string; answer: 'text' | 'json'; optionsMode?: 'suggested' | 'exclusive'; options?: { label: string; value: string; recommended?: boolean; reason?: string }[] };
  status: 'pending' | 'answering' | 'answered' | 'closed' | 'outcome_unknown';
  available: boolean;
  answer?: unknown;
  reason?: string;
}
export async function getAiQuestions(runId: string, signal = new AbortController().signal): Promise<AiQuestionItem[]> {
  return readRunArtifact(`/api/runs/${encodeURIComponent(runId)}/ai-questions`, value => value as AiQuestionItem[], signal);
}
export async function answerAiQuestion(runId: string, key: AiQuestionKey, value: unknown): Promise<string> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/ai-questions/answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }),
  });
  const result = await response.json() as { receipt?: string; error?: string };
  if (result.receipt) return result.receipt;
  throw new Error(result.error ?? 'Answer delivery could not be confirmed');
}
