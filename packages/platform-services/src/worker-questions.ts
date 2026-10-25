import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import { isJsonValue, type JsonValue } from '@openhilo/ai-contracts';
import { isAiQuestionKey, type AiQuestionKey, type QuestionAnswerReceipt } from './ai-questions';
import { sendWorkerMessage, type WorkerMessage } from './worker-protocol';

const deliveryError = () => Object.assign(new Error('Answer delivery outcome is unknown; inspect question history before retrying'), { statusCode: 503 });

/** Parent-side transport. A lost receipt is never retried automatically. */
export function createWorkerQuestionClient(worker: ChildProcess, timeoutMs = 30_000) {
  const pending = new Map<string, { resolve(value: QuestionAnswerReceipt): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let closed = false;
  function settle(reqId: string, error?: Error, receipt?: QuestionAnswerReceipt) {
    const entry = pending.get(reqId);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(reqId);
    error ? entry.reject(error) : entry.resolve(receipt!);
  }
  const onMessage = (message: WorkerMessage) => {
    if (!message || message.type !== 'ai_answer_result') return;
    const valid = ['accepted', 'duplicate', 'closed', 'unknown_question', 'invalid_answer', 'in_progress', 'outcome_unknown', 'unavailable'];
    if (message.error || !valid.includes(message.receipt ?? '')) settle(message.reqId, deliveryError());
    else settle(message.reqId, undefined, message.receipt);
  };
  const close = () => {
    closed = true;
    for (const id of pending.keys()) settle(id, deliveryError());
    worker.off('message', onMessage); worker.off('exit', close); worker.off('disconnect', close);
  };
  worker.on('message', onMessage); worker.once('exit', close); worker.once('disconnect', close);
  return {
    answer(key: AiQuestionKey, value: JsonValue): Promise<QuestionAnswerReceipt> {
      if (!isAiQuestionKey(key) || !isJsonValue(value)) return Promise.reject(Object.assign(new Error('Invalid question answer'), { statusCode: 400 }));
      if (closed || !worker.connected) return Promise.resolve('unavailable');
      const reqId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(reqId, deliveryError()), timeoutMs);
        pending.set(reqId, { resolve, reject, timer });
        try { worker.send({ type: 'ai_answer', reqId, key, value } satisfies WorkerMessage, error => { if (error) settle(reqId, deliveryError()); }); }
        catch { settle(reqId, deliveryError()); }
      });
    },
    close,
  };
}

/** Child-side bridge; drain all answer receipts before announcing run completion/exiting. */
export function createWorkerQuestionServer(answer: (key: AiQuestionKey, value: JsonValue) => Promise<QuestionAnswerReceipt>, options: { onDisconnect?(): void | Promise<void> } = {}) {
  const pending = new Set<Promise<void>>();
  let fault: Error | undefined;
  const onMessage = (message: WorkerMessage) => {
    if (!message || message.type !== 'ai_answer' || typeof message.reqId !== 'string') return;
    const operation = (async () => {
      let response: Extract<WorkerMessage, { type: 'ai_answer_result' }>;
      try {
        if (!isAiQuestionKey(message.key) || !isJsonValue(message.value)) throw new Error('Invalid question answer');
        response = { type: 'ai_answer_result', reqId: message.reqId, receipt: await answer(message.key, message.value) };
      } catch { response = { type: 'ai_answer_result', reqId: message.reqId, error: 'Question service could not confirm the answer' }; }
      await sendWorkerMessage(response);
    })().catch(error => { fault ??= error instanceof Error ? error : new Error(String(error)); });
    pending.add(operation);
    void operation.then(() => pending.delete(operation));
  };
  const onDisconnect = () => {
    void Promise.resolve().then(() => options.onDisconnect?.()).catch(error => { fault ??= error instanceof Error ? error : new Error(String(error)); });
  };
  process.on('message', onMessage);
  process.once('disconnect', onDisconnect);
  return {
    async drain() { while (pending.size) await Promise.all([...pending]); if (fault) throw fault; },
    close() { process.off('message', onMessage); process.off('disconnect', onDisconnect); },
  };
}
