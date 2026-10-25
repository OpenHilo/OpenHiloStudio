import { GenerationServerDriver, type GenerationDriverSession, type SessionStorage } from './generation-server';
import type { SerializedSession, SessionInput, SessionStep } from './generation-session';
import * as path from 'path';

export interface GenerationStartInput { naturalLanguage: string; workspace?: string; requestId?: string }

export interface GenerationSummary {
  sessionId: string;
  naturalLanguage: string;
  phase: SessionStep['phase'] | 'unavailable';
  updatedAt: string;
  published?: boolean;
  canDelete?: boolean;
}
export type GenerationGroup = 'attention' | 'active' | 'published' | 'ended' | 'error';
export interface GenerationList { sessions: GenerationSummary[]; total: number; counts?: Record<GenerationGroup, number>; allTotal?: number }
export function generationGroup(task: GenerationSummary): GenerationGroup {
  if (task.phase === 'cc_waiting_for_answer' || task.phase === 'confirm_merge') return 'attention';
  if (task.phase === 'cc_running' || task.phase === 'auto_fixing') return 'active';
  if (task.phase === 'done') return task.published ? 'published' : 'ended';
  return 'error';
}

export interface HostedGenerationSession<Snapshot extends SerializedSession = SerializedSession> extends GenerationDriverSession<Snapshot> {
  readonly id: string;
  close(reason?: string): Promise<void>;
}
export interface GenerationServiceOptions<Snapshot extends SerializedSession, Session extends HostedGenerationSession<Snapshot>> {
  storage: SessionStorage<Snapshot>;
  /** Return a fresh, unstarted session with a unique id and its own sessionDir. */
  /** Honor the supplied id for retry-safe creation; omit it for older callers. */
  create(input: GenerationStartInput, id?: string): Session | Promise<Session>;
  /** Rebind the saved deployment identity and live services only when continuing work. */
  restore(data: Snapshot): Session | Promise<Session>;
  /** Read-only projection: no provider, credentials, tools or worktree checkout. */
  inspect(data: Snapshot): GenerationDriverSession<Snapshot> | Promise<GenerationDriverSession<Snapshot>>;
  bind?(session: Session): void;
  onBackgroundError?(error: unknown): void;
}

/** One service owns its live sessions and serializes continuation through one driver. */
export function createGenerationService<Snapshot extends SerializedSession, Session extends HostedGenerationSession<Snapshot>>(options: GenerationServiceOptions<Snapshot, Session>) {
  const driver = new GenerationServerDriver(), sessions = new Map<string, Session>();
  const owned = new Map<string, Session>(), starting = new Set<string>(), operations = new Set<Promise<unknown>>();
  const retired = new Map<Session, Promise<void>>();
  const creationRequests = new Map<string, { fingerprint: string; pending: Promise<{ sessionId: string; step: SessionStep }> }>();
  let closed = false, closing: Promise<void> | undefined;
  const terminal = (step: SessionStep) => step.phase === 'done' || (step.phase === 'error' && !step.retryable);
  const unavailable = () => Object.assign(new Error('Generation service is closed'), { statusCode: 503 });
  const report = (error: unknown) => { try { options.onBackgroundError?.(error); } catch { /* Diagnostics cannot authorize another attempt. */ } };
  function track<T>(pending: Promise<T>): Promise<T> {
    operations.add(pending);
    void pending.finally(() => operations.delete(pending)).catch(() => {});
    return pending;
  }
  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(unavailable());
    return track(Promise.resolve().then(() => { if (closed) throw unavailable(); return operation(); }));
  }
  function retire(session: Session): Promise<void> {
    let result = retired.get(session);
    if (!result) {
      result = (async () => {
        await session.close(); await session.flushPersistence?.();
        await options.storage.save(session.id, session.toJSON());
        sessions.delete(session.id); owned.delete(session.id);
      })().finally(() => retired.delete(session));
      retired.set(session, result);
    }
    return result;
  }
  const continuation = (id: string) => ({ sessions,
    restore: async (data: Snapshot) => {
      const session = await options.restore(data);
      owned.set(id, session);
      if (closed) { await session.close(); throw unavailable(); }
      return session;
    }, bind: options.bind,
    onAsyncStep(step: SessionStep) {
      const session = owned.get(id);
      if (terminal(step) && session) void track(retire(session)).catch(report);
    }, onBackgroundError: report,
  });
  return {
    start(input: GenerationStartInput) {
      const requestId = input.requestId;
      if (requestId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))
        return Promise.reject(Object.assign(new Error('requestId must be a UUID'), { statusCode: 400 }));
      const conflict = () => Object.assign(new Error('This creation identity is already reserved for another or unconfirmed request. Check generation history; no new task was started.'), { statusCode: 409 });
      const fingerprint = JSON.stringify([input.naturalLanguage, input.workspace ?? null]);
      const pending = requestId ? creationRequests.get(requestId) : undefined;
      if (pending) return pending.fingerprint === fingerprint ? run(() => pending.pending) : Promise.reject(conflict());
      const operation = run(async () => {
        if (requestId) {
          const saved = await options.storage.load(requestId);
          if (saved) {
            if (saved.naturalLanguage !== input.naturalLanguage ||
                (input.workspace !== undefined && path.resolve(input.workspace) !== path.resolve(saved.config.workspace))) throw conflict();
            const step = await driver.read(requestId, options.storage, { sessions, restore: options.inspect });
            if (!step) throw conflict();
            return { sessionId: requestId, step };
          }
        }
        const session = await options.create(input, requestId), id = session.id;
        if (requestId && id !== requestId) { await session.close(); throw new Error('Generation factory must preserve the requested creation identity'); }
        if (owned.get(id) === session) throw new Error('Generation factory returned an already owned session');
        if (closed) { await session.close(); throw unavailable(); }
        if (starting.has(id) || owned.has(id)) { await session.close(); throw new Error('Generation session id is already in use'); }
        starting.add(id);
        let persisted = false;
        try {
          if (await options.storage.load(id)) throw new Error('Generation session id is already in use');
          owned.set(id, session);
          if (closed) { await session.close(); throw unavailable(); }
          sessions.set(id, session);
          await options.storage.save(id, session.toJSON());
          persisted = true;
          // Return the durable identity before the first AI response so clients
          // can poll live health. The driver owns background work and shutdown.
          const step = await driver.respond(id, { type: 'start', naturalLanguage: input.naturalLanguage }, options.storage, continuation(id));
          return { sessionId: id, step };
        } catch (error) {
          if (owned.get(id) === session) {
            try {
              if (persisted) await retire(session);
              else {
                // No work was accepted. Close without writing another snapshot;
                // a storage error may mean either no write or an unknown receipt.
                await session.close(); sessions.delete(id); owned.delete(id);
              }
            } catch (failure) { report(failure); }
          } else { try { await session.close(); } catch (failure) { report(failure); } }
          throw error;
        } finally { starting.delete(id); }
      });
      if (requestId) {
        creationRequests.set(requestId, { fingerprint, pending: operation });
        void operation.finally(() => creationRequests.delete(requestId)).catch(() => {});
      }
      return operation;
    },
    respond(id: string, input: SessionInput): Promise<SessionStep> {
      return run(async () => {
        const step = await driver.respond(id, input, options.storage, continuation(id));
        const session = owned.get(id);
        if (terminal(step) && session) await retire(session);
        return step;
      });
    },
    stop(id: string): Promise<SessionStep> {
      return run(async () => {
        const session = owned.get(id);
        const step = await driver.read(id, options.storage, { sessions, restore: options.inspect });
        if (!step) throw Object.assign(new Error('Session not found'), { statusCode: 404 });
        if (!session || !['cc_running', 'cc_waiting_for_answer', 'auto_fixing'].includes(step.phase)) return step;
        await session.close('Generation stopped by user');
        await retire(session);
        return session.currentStep();
      });
    },
    read(id: string): Promise<SessionStep | null> {
      return run(() => driver.read(id, options.storage, { sessions, restore: options.inspect }));
    },
    restoreHistory(id: string): Promise<void> {
      return run(async () => {
        if (!options.storage.restoreHistory) throw Object.assign(new Error('History restore is not supported by this storage'), { statusCode: 501 });
        if (!await options.storage.load(id)) throw Object.assign(new Error('Session not found'), { statusCode: 404 });
        await options.storage.restoreHistory(id);
      });
    },
    removeHistory(id: string): Promise<void> {
      return run(async () => {
        if (!options.storage.removeHistory) throw Object.assign(new Error('History deletion is not supported by this storage'), { statusCode: 501 });
        const step = await driver.read(id, options.storage, { sessions, restore: options.inspect });
        if (!step) throw Object.assign(new Error('Session not found'), { statusCode: 404 });
        if (!terminal(step)) throw Object.assign(new Error('Finish this task before deleting its history.'), { statusCode: 409 });
        await options.storage.removeHistory(id);
      });
    },
    list({ offset = 0, limit = 20, group }: { offset?: number; limit?: number; group?: GenerationGroup | 'recent' } = {}): Promise<GenerationList> {
      return run(async () => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw Object.assign(new Error('Invalid generation list range'), { statusCode: 400 });
        }
        if (!options.storage.list) throw Object.assign(new Error('Generation history is not supported by this storage'), { statusCode: 501 });
        if (group !== undefined && !['recent', 'attention', 'active', 'published', 'ended', 'error'].includes(group)) {
          throw Object.assign(new Error('Invalid generation group'), { statusCode: 400 });
        }
        const page = await options.storage.list(group ? { offset: 0, limit: 100 } : { offset, limit });
        if (group) {
          // Count before pagination, so older actionable requests remain discoverable.
          for (let cursor = page.entries.length; cursor < page.total;) {
            const next = await options.storage.list({ offset: cursor, limit: 100 });
            if (!next.entries.length) break;
            page.entries.push(...next.entries); cursor += next.entries.length;
          }
        }
        const summaries = await Promise.all(page.entries.map(async entry => {
          try {
            const step = await driver.read(entry.id, options.storage, { sessions, restore: options.inspect });
            if (!step) throw new Error('Session snapshot is missing');
            return { sessionId: entry.id, updatedAt: entry.updatedAt, naturalLanguage: step.naturalLanguage ?? '', phase: step.phase, canDelete: Boolean(options.storage.removeHistory) && terminal(step),
              ...(step.phase === 'done' ? { published: Boolean(step.savedPath || step.savedPaths?.length) } : {}) } satisfies GenerationSummary;
          } catch (error) {
            report(error);
            return { sessionId: entry.id, updatedAt: entry.updatedAt, naturalLanguage: '', phase: 'unavailable' } satisfies GenerationSummary;
          }
        }));
        if (!group) return { sessions: summaries, total: page.total };
        const counts: Record<GenerationGroup, number> = { attention: 0, active: 0, published: 0, ended: 0, error: 0 };
        for (const task of summaries) counts[generationGroup(task)]++;
        const filtered = group === 'recent' ? summaries : summaries.filter(task => generationGroup(task) === group);
        return { sessions: filtered.slice(offset, offset + limit), total: filtered.length, allTotal: summaries.length, counts };
      });
    },
    async drain(): Promise<void> {
      do { await Promise.allSettled([...operations]); await driver.drain(); } while (operations.size);
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const failures: unknown[] = [], stopped = new Set<Session>();
        const stopOwned = async () => {
          await Promise.all([...owned.values()].filter(session => !stopped.has(session)).map(async session => {
            stopped.add(session);
            try { await session.close(); } catch (error) { failures.push(error); }
          }));
        };
        await stopOwned();
        do { await Promise.allSettled([...operations]); await driver.drain(); await stopOwned(); } while (operations.size);
        for (const session of owned.values()) {
          try { await session.flushPersistence?.(); await options.storage.save(session.id, session.toJSON()); }
          catch (error) { failures.push(error); }
        }
        sessions.clear(); owned.clear();
        if (failures.length) throw new AggregateError(failures, 'Generation shutdown could not finish all cleanup or persistence');
      })();
      return closing;
    },
  };
}
