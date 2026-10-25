import type { Schedule, ScheduleAttempt, ScheduleChange, PatchScheduleInput } from './schedule-service';
import type { ForkRunOpts } from './worker-supervisor';

export interface ScheduleRepository {
  list(): Promise<Schedule[]>;
  patch(id: string, patch: PatchScheduleInput): Promise<Schedule | null>;
  subscribe?(listener: (event: ScheduleChange) => void): () => void;
}
export interface SchedulerOptions {
  repository: ScheduleRepository;
  clock: { timeZone?: string; validate(expression: string): boolean; schedule(expression: string, callback: () => void): { stop(): void; getNextRun?(): Date | null } };
  launch(options: ForkRunOpts): Promise<string>;
  now?: () => Date;
  onError?: (error: unknown, schedule: Schedule) => void;
}
type Registration = { signature: string; schedule: Schedule; stop(): void; getNextRun?(): Date | null };

/** Process-local timer ownership. AI providers and worker launch mechanisms are injected. */
export class Scheduler {
  private tasks = new Map<string, Registration>();
  private launching = new Set<string>();
  private receipts = new Map<string, ScheduleAttempt>();
  private pending = new Set<Promise<void>>();
  private unsubscribe?: () => void;
  private started = false;
  private accepting = true;
  private epoch = 0;
  private starting?: Promise<void>;
  constructor(private readonly options: SchedulerOptions) {}

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.started) return Promise.resolve();
    this.started = true; this.accepting = true;
    const epoch = ++this.epoch, changed = new Set<string>();
    let loading = true;
    this.unsubscribe = this.options.repository.subscribe?.(event => {
      const id = event.type === 'delete' ? event.id : event.schedule.id;
      if (loading) changed.add(id);
      if (event.type === 'delete') this.unregister(id);
      else {
        try { this.register(event.schedule); }
        catch (error) { this.report(error, event.schedule); }
      }
    });
    const starting = this.options.repository.list().then(schedules => {
      if (epoch !== this.epoch) return;
      for (const schedule of schedules) if (!changed.has(schedule.id)) this.register(schedule);
    }).catch(error => { if (epoch === this.epoch) this.stop(); throw error; });
    this.starting = starting;
    void starting.finally(() => { loading = false; changed.clear(); if (this.starting === starting) this.starting = undefined; }).catch(() => {});
    return starting;
  }

  register(value: Schedule): void {
    if (!this.accepting) return;
    if (!value.enabled) { this.unregister(value.id); return; }
    const schedule = structuredClone(value);
    const expression = schedule.flexible && schedule.assignedCron ? schedule.assignedCron : schedule.cron;
    if (!this.options.clock.validate(expression)) { this.unregister(schedule.id); throw new Error('Invalid schedule cron expression'); }
    const signature = JSON.stringify([expression, schedule.ittPath, schedule.workdir, schedule.inputs, schedule.inputEncoding]);
    if (this.tasks.get(schedule.id)?.signature === signature) return;
    this.unregister(schedule.id);
    const registration: Registration = { signature, schedule, stop() {} };
    this.tasks.set(schedule.id, registration);
    try {
      const task = this.options.clock.schedule(expression, () => {
        // Ignore a callback already queued when this timer was replaced, disabled or stopped.
        if (this.tasks.get(schedule.id) !== registration || this.launching.has(schedule.id)) return;
        this.launching.add(schedule.id);
        const operation = this.launch(schedule, registration).catch(error => this.report(error, schedule));
        this.pending.add(operation);
        void operation.finally(() => { this.pending.delete(operation); this.launching.delete(schedule.id); });
      });
      registration.stop = () => task.stop();
      if (task.getNextRun) registration.getNextRun = () => task.getNextRun!();
    } catch (error) { this.tasks.delete(schedule.id); throw error; }
  }
  update(schedule: Schedule): void { this.register(schedule); }
  /** Read the actual clock registration; never persist a stale prediction. */
  timing(id: string): { nextRunAt?: string; timeZone?: string; lastAttempt?: ScheduleAttempt } {
    const next = this.tasks.get(id)?.getNextRun?.();
    return { ...(this.receipts.has(id) ? { lastAttempt: structuredClone(this.receipts.get(id)!) } : {}), ...(next && Number.isFinite(next.getTime()) ? { nextRunAt: next.toISOString() } : {}),
      ...(this.options.clock.timeZone ? { timeZone: this.options.clock.timeZone } : {}) };
  }
  unregister(id: string): void {
    const task = this.tasks.get(id); this.tasks.delete(id);
    try { task?.stop(); } catch (error) { if (task) this.report(error, task.schedule); }
  }
  stop(): void {
    this.epoch++; this.started = false; this.accepting = false; this.starting = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    for (const id of [...this.tasks.keys()]) this.unregister(id);
  }
  /** Waits for launch receipts, not completion/cancellation of the launched workflows. */
  async drain(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending]); }
  private async launch(schedule: Schedule, registration: Registration): Promise<void> {
    const startedAt = (this.options.now?.() ?? new Date()).toISOString();
    let runId: string | undefined;
    const record = async (attempt: ScheduleAttempt, fields: PatchScheduleInput = {}) => {
      this.receipts.set(schedule.id, attempt);
      const saved = await this.options.repository.patch(schedule.id, { ...fields, lastAttempt: attempt });
      if (!saved) this.receipts.delete(schedule.id);
      return saved;
    };
    try {
      // Persist intent before launch. If recording fails, do not create an invisible run.
      if (!await record({ startedAt, status: 'pending' })) return;
      // Disabling/deleting while persistence was pending cancels this unstarted trigger.
      if (this.tasks.get(schedule.id) !== registration || !this.accepting) {
        await record({ startedAt, status: 'failed', finishedAt: (this.options.now?.() ?? new Date()).toISOString(), error: 'Schedule stopped before launch.' });
        return;
      }
      runId = await this.options.launch({ ittPath: schedule.ittPath, workdir: schedule.workdir,
        inputs: structuredClone(schedule.inputs), ...(schedule.inputEncoding ? { inputEncoding: schedule.inputEncoding } : {}), suspend: true, triggeredBy: 'schedule' });
      const finishedAt = (this.options.now?.() ?? new Date()).toISOString();
      await record({ startedAt, status: 'launched', finishedAt, runId }, { lastRunId: runId, lastRunAt: finishedAt });
    } catch (error) {
      const attempt: ScheduleAttempt = { startedAt, status: runId ? 'unknown' : 'failed',
        finishedAt: (this.options.now?.() ?? new Date()).toISOString(), ...(runId ? { runId } : {}),
        error: runId ? 'Run created, but its launch receipt could not be saved. Check run history before retrying.' : (error instanceof Error ? error.message : String(error)) };
      try { await record(attempt); } catch (storageError) { this.report(storageError, schedule); }
      this.report(error, schedule);
    }
  }
  private report(error: unknown, schedule: Schedule): void {
    try {
      if (this.options.onError) this.options.onError(error, structuredClone(schedule));
      else console.error(`[Scheduler] Failed schedule ${schedule.id}:`, error);
    } catch { /* Diagnostic observers cannot create unhandled launch failures. */ }
  }
}
