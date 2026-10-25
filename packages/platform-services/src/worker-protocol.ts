import type { JsonValue } from '@openhilo/ai-contracts';
import type { AiQuestionKey, QuestionAnswerReceipt } from './ai-questions';
import type { RunStatus, LogEvent } from '@openhilo/runtime-contracts';

export type WorkerMessage =
  | { type: 'ai_answer'; reqId: string; key: AiQuestionKey; value: JsonValue }
  | { type: 'ai_answer_result'; reqId: string; receipt?: QuestionAnswerReceipt; error?: string }
  | { type: 'started'; runId: string; runDir: string }  // sent immediately after run dir is created
  | { type: 'event'; event: LogEvent }
  | { type: 'done'; runId: string; status: RunStatus }
  | { type: 'error'; message: string }
  | { type: 'sys_call'; reqId: string; method: string; args: unknown[] }
  | { type: 'sys_response'; reqId: string; result?: unknown; error?: string };

/** The child awaits IPC delivery before exiting. */
export function sendWorkerMessage(message: WorkerMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error('Worker parent is disconnected'));
    process.send(message, error => error ? reject(error) : resolve());
  });
}

/** Ordered event delivery with an explicit drain before a terminal worker message. */
export function createWorkerEventForwarder(onFailure?: (error: unknown) => void | Promise<void>) {
  let pending: Promise<void> = Promise.resolve();
  let fault: unknown;
  return {
    publish(event: LogEvent): void {
      const copy = JSON.parse(JSON.stringify(event)) as LogEvent;
      pending = pending.then(async () => {
        if (fault) return;
        try { await sendWorkerMessage({ type: 'event', event: copy }); }
        catch (error) { fault = error; try { await onFailure?.(error); } catch { /* Preserve the delivery failure. */ } }
      });
    },
    async drain(): Promise<void> { await pending; if (fault) throw fault; },
  };
}
