import { randomUUID } from 'crypto';
import { assertCanStart, ContractError, validateOutputs, type AiTaskExecutor, type TaskRequest, type TaskResult } from '@openhilo/ai-contracts';

export interface SkillSuggestionInput { fnName: string; role: string; intent: string; currentSkills: string[] }
export interface SkillSuggestionOptions { signal?: AbortSignal; timeoutMs?: number }

/** A read-only suggestion task. The caller owns the catalogue, confirmation and source edits. */
export async function suggestSkills(input: SkillSuggestionInput, catalogue: readonly string[], executor: AiTaskExecutor,
  options: SkillSuggestionOptions = {}): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Skill suggestion timeout must be a positive integer');
  const request: TaskRequest = { version: 1, taskId: randomUUID(),
    role: 'You are a workflow skill matcher. Return a JSON array of skill names, without markdown or explanation.',
    instruction: 'Select at most three relevant skills from the supplied catalogue for this function. Return an empty array if none fit.',
    inputs: { fnName: input.fnName, role: input.role, intent: input.intent, currentSkills: [...input.currentSkills], catalogue: [...catalogue] },
    output: { skills: 'json' }, requiredCapabilities: ['structured_output'],
  };
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let asked = false;
  const host = { attemptId: randomUUID(), signal: controller.signal, deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    onEvent(event: { type: string }) { if (event.type === 'question') { asked = true; controller.abort('Skill suggestions cannot ask questions'); } },
  };
  let execution: Awaited<ReturnType<AiTaskExecutor['start']>> | undefined;
  let result: TaskResult | undefined;
  try {
    assertCanStart(request, host, executor.id, executor.capabilities);
    execution = await executor.start(request, host);
    result = await execution.result;
    if (asked) throw new ContractError({ code: 'unsupported_capability', message: 'Skill suggestion executor requested interactive input', retryable: false, safeToReplay: false });
    if (result.status === 'failed') throw new ContractError(result.error);
    if (result.status === 'cancelled') throw new Error(`Skill suggestion cancelled: ${result.reason}`);
    const { skills } = validateOutputs(request.output, result.outputs);
    if (!Array.isArray(skills) || !skills.every(value => typeof value === 'string')) throw new Error('Skill suggestion must be a JSON array of names');
    const allowed = new Set(catalogue);
    return [...new Set(skills.filter(value => allowed.has(value)))].slice(0, 3);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    const session = result?.session ?? execution?.session;
    if (session) await executor.releaseSession?.(session);
  }
}
