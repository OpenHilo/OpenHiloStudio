import { validateRunInputWire, type RunInputEncoding } from '@openhilo/itt-contracts/run-inputs';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface ScheduleAttempt {
  startedAt: string; status: 'pending' | 'launched' | 'failed' | 'unknown';
  finishedAt?: string; runId?: string; error?: string;
}
export interface Schedule {
  id: string; name: string; cron: string; ittPath: string; workdir: string;
  inputs: Record<string, string>; inputEncoding?: RunInputEncoding; enabled: boolean;
  lastAttempt?: ScheduleAttempt;
  lastRunId?: string; lastRunAt?: string; nextRunAt?: string;
  flexible?: boolean; assignedCron?: string;
}
export type CreateScheduleInput = Pick<Schedule, 'name' | 'cron' | 'ittPath' | 'workdir' | 'inputs' | 'inputEncoding'> & { enabled?: boolean; flexible?: boolean };
export type PatchScheduleInput = Partial<Omit<Schedule, 'id' | 'assignedCron'>>;
export type ScheduleChange = { type: 'upsert'; schedule: Schedule } | { type: 'delete'; id: string };
export interface ScheduleServiceOptions {
  validateCron: (expression: string) => boolean;
  /** Composition-specific preflight; never called while merely reading existing records. */
  validateTarget?: (schedule: Readonly<Schedule>) => void | Promise<void>;
  random?: () => number;
  onListenerError?: (error: unknown) => void;
}
export class ScheduleValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ScheduleValidationError'; }
}
export class ScheduleStorageError extends Error {
  constructor() { super('Stored schedules are invalid; no changes were written'); this.name = 'ScheduleStorageError'; }
}
const editable = ['name', 'cron', 'ittPath', 'workdir', 'inputs', 'enabled', 'flexible', 'inputEncoding'];
function inputObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScheduleValidationError('Schedule input must be an object');
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ScheduleValidationError('Schedule input contains unsupported fields');
  return value as Record<string, unknown>;
}

function validateFlexibleClock(cron: string): void {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduleValidationError('Flexible schedules require five cron fields');
  if (!/^\d{1,2}$/.test(parts[0]) || Number(parts[0]) > 59 || !/^\d{1,2}$/.test(parts[1]) || Number(parts[1]) > 23) {
    throw new ScheduleValidationError('Flexible schedules require a single minute (0–59) and hour (0–23). Use a non-flexible schedule for recurring times.');
  }
}

/**
 * Assigns a load-balanced minute to a flexible schedule.
 *
 * Phase 1 (24 slots):  one per hour at :00
 * Phase 2 (+24 slots): one per hour at :30
 * Phase 3 (+96 slots): :10, :20, :40, :50 per hour
 *
 * Picks the slot with minimum existing flexible schedules.
 * Among ties, prefers the preferred hour from the input cron, then picks randomly.
 *
 * @param cron - A valid 5-part cron with a single minute and hour (one preferred time per matching day).
 */
export function assignFlexibleSlot(cron: string, existingSchedules: Schedule[], random: () => number = Math.random): string {
  validateFlexibleClock(cron);
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduleValidationError('Flexible schedules require five cron fields');
  // parts: [minute, hour, dom, month, dow]

  const counts = new Map<string, number>();
  for (const s of existingSchedules) {
    if (!s.flexible || !s.assignedCron) continue;
    const ap = s.assignedCron.trim().split(/\s+/);
    const key = `${ap[0]}_${ap[1]}`;  // minute_hour
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const phases: number[][] = [
    [0],
    [30],
    [10, 20, 40, 50],
  ];

  for (const minutes of phases) {
    const slots: { minute: number; hour: number; count: number }[] = [];
    for (let h = 0; h < 24; h++) {
      for (const m of minutes) {
        const key = `${m}_${h}`;
        slots.push({ minute: m, hour: h, count: counts.get(key) ?? 0 });
      }
    }

    const minCount = Math.min(...slots.map(s => s.count));
    if (minCount === 0) {
      const candidates = slots.filter(s => s.count === 0);
      const preferredHour = parseInt(parts[1], 10);
      const preferred = candidates.filter(s => s.hour === preferredHour);
      const pool = preferred.length > 0 ? preferred : candidates;
      const chosen = pool[Math.floor(random() * pool.length)];
      const result = [...parts];
      result[0] = String(chosen.minute);
      result[1] = String(chosen.hour);
      return result.join(' ');
    }
  }

  // All 144 slots saturated — fall back to random minute
  const result = [...parts];
  result[0] = String(Math.floor(random() * 60));
  return result.join(' ');
}

/** Single-owner local schedule repository; mutations are serialized and atomically replaced. */
export class ScheduleService {
  private pending: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(event: ScheduleChange) => void>();
  constructor(private readonly filePath: string, private readonly options: ScheduleServiceOptions) {
    if (!path.isAbsolute(filePath)) throw new Error('Schedule filePath must be absolute');
  }
  subscribe(listener: (event: ScheduleChange) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  async list(): Promise<Schedule[]> { await this.pending; return this.read(); }
  create(input: CreateScheduleInput): Promise<Schedule> {
    return this.mutate(async () => {
      inputObject(input, editable);
      const schedules = this.read();
      const schedule: Schedule = { ...structuredClone(input), id: randomUUID(), enabled: input.enabled === undefined ? true : input.enabled };
      this.validate(schedule, false);
      if (schedule.flexible) schedule.assignedCron = assignFlexibleSlot(schedule.cron, schedules, this.options.random);
      this.validate(schedule);
      await this.options.validateTarget?.(structuredClone(schedule));
      this.write([...schedules, schedule]);
      this.emit({ type: 'upsert', schedule });
      return schedule;
    });
  }
  patch(id: string, updates: PatchScheduleInput): Promise<Schedule | null> {
    return this.mutate(async () => {
      inputObject(updates, [...editable, 'lastRunId', 'lastRunAt', 'nextRunAt', 'lastAttempt']);
      const schedules = this.read(), index = schedules.findIndex(item => item.id === id);
      if (index < 0) return null;
      const schedule = { ...schedules[index], ...structuredClone(updates) };
      this.validate(schedule, false);
      // Keep historical records readable/disableable and receipt writes safe,
      // but never activate or redefine a flexible schedule that loses frequency.
      if (schedule.flexible && (updates.cron !== undefined || updates.flexible !== undefined || updates.enabled === true)) validateFlexibleClock(schedule.cron);
      if (schedule.flexible && (updates.cron !== undefined || updates.flexible !== undefined)) {
        schedule.assignedCron = assignFlexibleSlot(schedule.cron, schedules.filter(item => item.id !== id), this.options.random);
      }
      if (!schedule.flexible) delete schedule.assignedCron;
      this.validate(schedule, false);
      const targetChanged = ['ittPath', 'workdir', 'inputs', 'inputEncoding'].some(key => Object.prototype.hasOwnProperty.call(updates, key));
      const enablingOrEditing = schedule.enabled && Object.keys(updates).some(key => editable.includes(key));
      if (targetChanged || enablingOrEditing) await this.options.validateTarget?.(structuredClone(schedule));
      schedules[index] = schedule; this.write(schedules);
      if (Object.keys(updates).some(key => editable.includes(key))) this.emit({ type: 'upsert', schedule });
      return schedule;
    });
  }
  delete(id: string): Promise<boolean> {
    return this.mutate(() => {
      const schedules = this.read(), next = schedules.filter(item => item.id !== id);
      if (next.length === schedules.length) return false;
      this.write(next); this.emit({ type: 'delete', id }); return true;
    });
  }
  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {}); return result;
  }
  private emit(event: ScheduleChange): void {
    for (const listener of this.listeners) {
      try { listener(structuredClone(event)); }
      catch (error) { try { this.options.onListenerError?.(error); } catch { /* Observers cannot undo committed state. */ } }
    }
  }
  private read(): Schedule[] {
    let content: string;
    try { content = fs.readFileSync(this.filePath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    try {
      const value: unknown = JSON.parse(content);
      if (!Array.isArray(value)) throw new ScheduleStorageError();
      for (const schedule of value) this.validate(schedule, false);
      if (new Set(value.map(item => item.id)).size !== value.length) throw new ScheduleStorageError();
      return value;
    } catch { throw new ScheduleStorageError(); }
  }
  private validate(value: Schedule, requireAssigned = true): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScheduleValidationError('Invalid schedule');
    for (const field of ['id', 'name', 'cron', 'ittPath', 'workdir'] as const) {
      if (typeof value[field] !== 'string' || !value[field].trim()) throw new ScheduleValidationError(`Schedule ${field} must be a nonempty string`);
    }
    if (!this.options.validateCron(value.cron)) throw new ScheduleValidationError('Invalid cron expression');
    if (value.flexible && value.cron.trim().split(/\s+/).length !== 5) throw new ScheduleValidationError('Flexible schedules require five cron fields');
    if (typeof value.enabled !== 'boolean' || (value.flexible !== undefined && typeof value.flexible !== 'boolean')) throw new ScheduleValidationError('Schedule enabled/flexible flags must be booleans');
    try { validateRunInputWire(value.inputs, value.inputEncoding); }
    catch (error) { throw new ScheduleValidationError((error as Error).message); }
    for (const field of ['lastRunId', 'lastRunAt', 'nextRunAt'] as const) {
      if (value[field] !== undefined && typeof value[field] !== 'string') throw new ScheduleValidationError(`Schedule ${field} must be a string`);
    }
    if (value.lastAttempt !== undefined) {
      const attempt = value.lastAttempt;
      if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt) ||
        !['pending', 'launched', 'failed', 'unknown'].includes(attempt.status) ||
        typeof attempt.startedAt !== 'string' || !Number.isFinite(Date.parse(attempt.startedAt)) ||
        (attempt.finishedAt !== undefined && (typeof attempt.finishedAt !== 'string' || !Number.isFinite(Date.parse(attempt.finishedAt)))) ||
        (attempt.error !== undefined && typeof attempt.error !== 'string') ||
        (attempt.runId !== undefined && typeof attempt.runId !== 'string')) throw new ScheduleValidationError('Invalid schedule launch receipt');
    }
    if ((value.assignedCron !== undefined || (requireAssigned && value.flexible)) && (typeof value.assignedCron !== 'string' || !this.options.validateCron(value.assignedCron))) throw new ScheduleValidationError('Invalid assigned cron expression');
  }
  private write(schedules: Schedule[]): void {
    const directory = path.dirname(this.filePath), temporary = path.join(directory, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    fs.mkdirSync(directory, { recursive: true });
    let owned = false;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600); owned = true;
      try { fs.writeFileSync(fd, JSON.stringify(schedules, null, 2), 'utf8'); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filePath);
    } finally { if (owned) fs.rmSync(temporary, { force: true }); }
  }
}
