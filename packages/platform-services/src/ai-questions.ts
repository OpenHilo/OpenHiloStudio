import { randomUUID } from 'crypto';
import {
  isJsonValue, type AiExecution, type AnswerReceipt, type ExecutionHost,
  type JsonValue, type Question, type TaskRequest,
} from '@openhilo/ai-contracts';
import { createFileConfigStore } from './file-config';

export interface AiQuestionKey { taskId: string; attemptId: string; questionId: string }
export interface AiQuestionRecord extends AiQuestionKey {
  instruction: string;
  question: Question;
  status: 'pending' | 'answering' | 'answered' | 'closed' | 'outcome_unknown';
  askedAt: string;
  updatedAt: string;
  answer?: JsonValue;
  reason?: string;
}
export type QuestionAnswerReceipt = AnswerReceipt | 'in_progress' | 'outcome_unknown' | 'unavailable';
interface Snapshot { version: 1; questions: AiQuestionRecord[] }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (a: AiQuestionKey, b: AiQuestionKey) => a.taskId === b.taskId && a.attemptId === b.attemptId && a.questionId === b.questionId;
export function isAiQuestionKey(value: unknown): value is AiQuestionKey {
  if (!value || typeof value !== 'object') return false;
  const key = value as AiQuestionKey;
  return [key.taskId, key.attemptId, key.questionId].every(part => typeof part === 'string' && part.trim().length > 0);
}
function isQuestion(value: unknown): value is Question {
  if (!isJsonValue(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const q = value as unknown as Question;
  return typeof q.id === 'string' && !!q.id.trim() && typeof q.prompt === 'string' && !!q.prompt.trim() &&
    ['text', 'json'].includes(q.answer) && (q.optionsMode === undefined || ['suggested', 'exclusive'].includes(q.optionsMode)) &&
    (q.options === undefined || (Array.isArray(q.options) && q.options.every(o => o && typeof o.label === 'string' && typeof o.value === 'string'))) &&
    (q.optionsMode !== 'exclusive' || !!q.options?.length);
}
function store(filePath: string) {
  return createFileConfigStore<Snapshot>({ filePath, defaults: () => ({ version: 1, questions: [] }), parse(raw) {
    const snapshot = raw as Snapshot;
    if (!isJsonValue(raw) || !snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.questions)) throw new Error('Invalid AI question history');
    const keys = new Set<string>();
    for (const q of snapshot.questions) {
      if (!isAiQuestionKey(q) || !isQuestion(q.question) || q.questionId !== q.question.id || typeof q.instruction !== 'string' ||
        !['pending', 'answering', 'answered', 'closed', 'outcome_unknown'].includes(q.status) ||
        typeof q.askedAt !== 'string' || typeof q.updatedAt !== 'string' || (q.reason !== undefined && typeof q.reason !== 'string')) {
        throw new Error('Invalid AI question history');
      }
      const key = JSON.stringify([q.taskId, q.attemptId, q.questionId]);
      if (keys.has(key)) throw new Error('Duplicate AI question history key');
      keys.add(key);
    }
    return copy(snapshot);
  } });
}

/** Read-only: does not recover live handles or rewrite an interrupted attempt. */
export function readAiQuestions(filePath: string): AiQuestionRecord[] { return store(filePath).load().questions; }

/** Single owner per file. Only JSON records are persisted; executions remain in memory. */
export function createAiQuestionService(options: { filePath: string }) {
  const storage = store(options.filePath);
  let records = storage.load().questions;
  let fault: Error | undefined;
  let closed = false;
  type Connection = { attemptId: string; controller: AbortController; execution?: AiExecution; finished: boolean };
  const connections = new Map<string, Connection>();
  const pendingAnswers = new Set<Promise<QuestionAnswerReceipt>>();
  function save(next: AiQuestionRecord[]) {
    storage.save({ questions: next });
    records = next;
  }
  function update(key: AiQuestionKey, patch: Partial<AiQuestionRecord>) {
    save(records.map(record => same(record, key) ? { ...record, ...patch, updatedAt: new Date().toISOString() } : record));
  }
  function fail(error: unknown) {
    fault ??= error instanceof Error ? error : new Error(String(error));
    for (const connection of connections.values()) {
      connection.controller.abort('AI question history could not be persisted');
      void connection.execution?.cancel('AI question history could not be persisted').catch(() => {});
    }
  }
  // A new service instance cannot recover another process's live question handles.
  if (records.some(q => q.status === 'pending' || q.status === 'answering')) {
    save(records.map(q => q.status === 'pending' || q.status === 'answering'
      ? { ...q, status: q.status === 'answering' ? 'outcome_unknown' : 'closed', reason: 'Previous execution is unavailable', updatedAt: new Date().toISOString() }
      : q));
  }
  function finish(taskId: string, connection: Connection) {
    connection.finished = true;
    try {
      const pending = records.filter(q => q.taskId === taskId && q.attemptId === connection.attemptId && q.status === 'pending');
      if (pending.length) save(records.map(q => pending.includes(q)
        ? { ...q, status: 'closed', reason: 'Execution ended', updatedAt: new Date().toISOString() } : q));
    } catch (error) { fail(error); }
    if (connections.get(taskId) === connection) connections.delete(taskId);
  }
  async function answer(key: AiQuestionKey, value: JsonValue): Promise<QuestionAnswerReceipt> {
    if (fault) throw fault;
    const record = records.find(q => same(q, key));
    if (!record) return 'unknown_question';
    if (record.status === 'answered') return 'duplicate';
    if (record.status === 'answering') return 'in_progress';
    if (record.status === 'outcome_unknown') return 'outcome_unknown';
    if (record.status === 'closed' || closed) return 'closed';
    const connection = connections.get(key.taskId);
    if (!connection?.execution || connection.attemptId !== key.attemptId || connection.finished) return 'unavailable';
    const question = record.question;
    if (!isJsonValue(value) || (question.answer === 'text' && typeof value !== 'string') ||
      (question.optionsMode === 'exclusive' && !question.options?.some(option => option.value === value))) return 'invalid_answer';
    // Commit intent before delivery. A crash after this point must never cause automatic resubmission.
    update(key, { status: 'answering' });
    let receipt: AnswerReceipt;
    try { receipt = await connection.execution.answer(key.questionId, copy(value)); }
    catch {
      update(key, { status: 'outcome_unknown', reason: 'Answer delivery outcome is unknown' });
      connection.controller.abort('Answer delivery outcome is unknown');
      void connection.execution.cancel('Answer delivery outcome is unknown').catch(() => {});
      return 'outcome_unknown';
    }
    if (receipt === 'accepted') update(key, { status: 'answered', answer: copy(value) });
    else if (receipt === 'duplicate') update(key, { status: 'answered' }); // Never attribute a new value to a prior answer.
    else if (receipt === 'invalid_answer') update(key, { status: connection.finished ? 'closed' : 'pending' });
    else update(key, { status: 'closed', reason: receipt });
    return receipt;
  }
  return {
    host(request: TaskRequest): Pick<ExecutionHost, 'attemptId' | 'signal' | 'onEvent'> {
      if (fault) throw fault;
      if (closed) throw new Error('AI question service is closed');
      if (connections.has(request.taskId)) throw new Error('AI task already has an active question connection');
      const connection: Connection = { attemptId: randomUUID(), controller: new AbortController(), finished: false };
      connections.set(request.taskId, connection);
      return { attemptId: connection.attemptId, signal: connection.controller.signal, onEvent(event) {
        if (closed || fault || connection.finished || event.taskId !== request.taskId || event.attemptId !== connection.attemptId) return;
        if (event.type !== 'question') return;
        try {
          if (!isQuestion(event.question)) throw new Error('Invalid AI question');
          const key = { taskId: event.taskId, attemptId: event.attemptId, questionId: event.question.id };
          if (records.some(q => same(q, key))) throw new Error('Duplicate AI question');
          save([...records, { ...key, instruction: request.instruction, question: copy(event.question), status: 'pending', askedAt: event.timestamp, updatedAt: event.timestamp }]);
        } catch (error) { fail(error); }
      } };
    },
    attach(execution: AiExecution, request: TaskRequest) {
      const connection = connections.get(request.taskId);
      if (!connection || connection.execution) throw new Error('No unbound AI question connection');
      connection.execution = execution;
      void execution.result.then(() => finish(request.taskId, connection), () => finish(request.taskId, connection));
      if (fault || closed) {
        void execution.cancel('AI question service is unavailable').catch(() => {});
        throw fault ?? new Error('AI question service is closed');
      }
    },
    answer(key: AiQuestionKey, value: JsonValue): Promise<QuestionAnswerReceipt> {
      const operation = answer(key, value).catch(error => { fail(error); throw error; });
      pendingAnswers.add(operation);
      void operation.then(() => pendingAnswers.delete(operation), () => pendingAnswers.delete(operation));
      return operation;
    },
    list: () => copy(records),
    async drain() { await Promise.allSettled([...pendingAnswers]); if (fault) throw fault; },
    async close() {
      closed = true;
      for (const [taskId, connection] of connections) {
        connection.controller.abort('AI question service closed');
        if (!connection.execution) finish(taskId, connection);
      }
      await Promise.allSettled([...connections.values()].map(c => c.execution?.cancel('AI question service closed')));
      await Promise.allSettled([...pendingAnswers]);
      if (fault) throw fault;
    },
  };
}
