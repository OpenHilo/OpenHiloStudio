import type { SerializedSession, SessionInput, SessionStep } from './generation-session';
import {validateRevision} from './generation-session';

export interface SessionStorage<Snapshot extends SerializedSession = SerializedSession> {
  removeHistory?(id: string): Promise<void>;
  restoreHistory?(id: string): Promise<void>;
  load(id: string): Promise<Snapshot | null>;
  save(id: string, data: Snapshot): Promise<void>;
  /** Read-only discovery, newest persisted update first. Optional for custom stores. */
  list?(options: { offset: number; limit: number }): Promise<{ entries: { id: string; updatedAt: string }[]; total: number }>;
}
export interface GenerationDriverSession<Snapshot extends SerializedSession = SerializedSession> {
  readonly config: { maxClarificationRounds: number };
  currentStep(): SessionStep;
  toJSON(): Snapshot;
  respond(input: SessionInput): Promise<SessionStep>;
  flushPersistence?(): Promise<void>;
}
interface SessionReader<Snapshot extends SerializedSession, Session extends GenerationDriverSession<Snapshot>> {
  sessions?: Map<string, Session>;
  restore(data: Snapshot): Session | Promise<Session>;
}
export interface GenerationRespondOptions<Snapshot extends SerializedSession, Session extends GenerationDriverSession<Snapshot>> extends SessionReader<Snapshot, Session> {
  bind?(session: Session): void;
  onAsyncStep?(step: SessionStep): void;
  /** Reports storage/observer errors; must not start or retry AI work. */
  onBackgroundError?(error: unknown): void;
}

/** One driver per service/storage scope. Locks are in-process, not distributed leases. */
export class GenerationServerDriver {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly attempts = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, Extract<SessionStep, { phase: 'error' }>>();

  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(id, queued);
    await previous;
    try { return await action(); }
    finally { release(); if (this.locks.get(id) === queued) this.locks.delete(id); }
  }

  async read<Snapshot extends SerializedSession, Session extends GenerationDriverSession<Snapshot>>(
    id: string, storage: SessionStorage<Snapshot>, options: SessionReader<Snapshot, Session>,
  ): Promise<SessionStep | null> {
    if (this.failures.has(id)) return structuredClone(this.failures.get(id)!);
    const live = options.sessions?.get(id);
    if (live) return live.currentStep();
    const saved = await storage.load(id);
    return saved ? (await options.restore(saved)).currentStep() : null;
  }

  async respond<Snapshot extends SerializedSession, Session extends GenerationDriverSession<Snapshot>>(
    id: string, input: SessionInput, storage: SessionStorage<Snapshot>, options: GenerationRespondOptions<Snapshot, Session>,
  ): Promise<SessionStep> {
    return this.locked(id, async () => {
      const staleAnswer = () => Object.assign(new Error('Your answer was not accepted because this question is no longer current. Refresh the task to see its current question or result.'), { statusCode: 409 });
      if (this.failures.has(id)) {
        if (input.type === 'mcp_answer') throw staleAnswer();
        return structuredClone(this.failures.get(id)!);
      }
      const initialAttempt = this.attempts.get(id);
      if (initialAttempt && input.type === 'mcp_answer') {
        // A live question can become visible before start() has persisted its
        // receipt. Finish that write, then apply the answer through the normal
        // identity/phase checks. Returning "running" here would drop the answer.
        if (options.sessions?.get(id)?.currentStep().phase !== 'cc_waiting_for_answer') {
          throw staleAnswer();
        }
        await initialAttempt;
        if (this.failures.has(id)) throw staleAnswer();
      }
      const existing = await storage.load(id);
      if (!existing) throw new Error(`Session ${id} not found; create and persist a session first`);
      if (input.type === 'feedback') {
        const accepted=(options.sessions?.get(id)?.toJSON() ?? existing).revisionRequests?.find(item=>item.reviewId===input.reviewId);
        if(accepted) {
          if(typeof input.message!=='string'||accepted.message!==input.message.trim()) throw Object.assign(new Error('This review already received a different change request.'),{statusCode:409});
          return options.sessions?.get(id)?.currentStep() ?? (await options.restore(existing)).currentStep();
        }
        validateRevision(input,options.sessions?.get(id)?.currentStep() ?? (await options.restore(existing)).currentStep());
      }
      if (this.attempts.has(id)) return { phase: 'cc_running', round: existing.round, maxRounds: existing.config.maxClarificationRounds,
        ...(existing.naturalLanguage ? { naturalLanguage: existing.naturalLanguage } : {}) };
      const session = options.sessions?.get(id) ?? await options.restore(existing);
      options.sessions?.set(id, session);
      options.bind?.(session);
      const step = session.currentStep(), snapshot = session.toJSON();
      if (input.type === 'mcp_answer' && step.phase !== 'cc_waiting_for_answer') throw staleAnswer();
      if (step.phase === 'error' && !step.retryable) return step;
      if (step.phase === 'cc_running' && !(snapshot.round === 0 && snapshot.naturalLanguage === '')) return step;
      const asynchronous = options.onAsyncStep && ((input.type === 'start' && snapshot.round === 0 && snapshot.naturalLanguage === '') ||
        input.type === 'feedback' ||
        (input.type === 'retry' && step.phase === 'error' && step.retryable));
      if (!asynchronous) {
        const next = await session.respond(input);
        await storage.save(id, session.toJSON());
        if (next.phase === 'done') options.sessions?.delete(id);
        return next;
      }
      const naturalLanguage = input.type === 'start' ? input.naturalLanguage : snapshot.naturalLanguage;
      const context = naturalLanguage ? { naturalLanguage } : {};
      const running: SessionStep = { phase: 'cc_running', round: snapshot.round + 1, maxRounds: session.config.maxClarificationRounds, ...context };
      const revisionRequests=input.type==='feedback' ? [...(snapshot.revisionRequests ?? []),{reviewId:input.reviewId,message:input.message.trim()}] : snapshot.revisionRequests;
      await storage.save(id, { ...snapshot, phase: 'cc_running', round: snapshot.round + 1, naturalLanguage, revisionRequests });
      const report = (error: unknown) => { try { options.onBackgroundError?.(error); } catch { /* telemetry cannot change state */ } };
      const notify = (next: SessionStep) => { try { options.onAsyncStep?.(structuredClone(next)); } catch (error) { report(error); } };
      const attempt = Promise.resolve().then(async () => {
        let next: SessionStep;
        try {
          next = await session.respond(input);
          await storage.save(id, session.toJSON());
          if (next.phase === 'done') options.sessions?.delete(id);
        } catch (error) {
          // An unexpected throw can follow effects or publication. Never infer replay safety.
          next = { phase: 'error', message: error instanceof Error ? error.message : String(error), retryable: false, ...context };
          this.failures.set(id, next);
          options.sessions?.delete(id);
          report(error);
          try {
            await session.flushPersistence?.();
            await storage.save(id, { ...session.toJSON(), naturalLanguage, phase: 'error', lastError: { message: next.message, retryable: false } });
          }
          catch (persistenceError) { report(persistenceError); }
        }
        notify(next);
      }).finally(() => { this.attempts.delete(id); });
      this.attempts.set(id, attempt);
      return running;
    });
  }

  /** Wait for accepted background operations during a controlled shutdown. */
  async drain(): Promise<void> { await Promise.all([...this.attempts.values()]); }
}
