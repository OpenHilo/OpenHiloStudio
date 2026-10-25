// src/executor/sys/index.ts
import type { CallNode, Value } from '@openhilo/itt-contracts';
export interface SystemCaller { caller: string }
import { FailableError } from '@openhilo/runtime-contracts';
import type { EntityStore } from './entity-store';
import { resolveBrainPath } from './brain-snapshot';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { platformSystemMethods } from './compiler-capabilities';

const SYS_METHOD_PARAMS = Object.fromEntries(Object.entries(platformSystemMethods)
  .filter(([method]) => method !== 'getWorkdir')
  .map(([method, signature]) => [method, signature.params]));

// ── Local schedule types (mirrors platform/server/types.ts Schedule) ──────────

interface Schedule {
  id: string;
  name: string;
  cron: string;
  ittPath: string;
  workdir: string;
  inputs: Record<string, string>;
  enabled: boolean;
  lastRunId?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  flexible?: boolean;
  assignedCron?: string;
}

function schedulePath(config: Extract<SysExecutorConfig, { mode: 'direct' }>): string {
  if (!config.scheduleFilePath) throw new FailableError('Schedule storage path is not configured');
  return config.scheduleFilePath;
}

function readSchedules(filePath: string): Schedule[] {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Schedule[];
}

function writeSchedules(filePath: string, schedules: Schedule[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(schedules, null, 2));
}

/**
 * Assigns a load-balanced minute to a flexible schedule.
 * Phase 1 (24 slots): one per hour at :00
 * Phase 2 (+24 slots): one per hour at :30
 * Phase 3 (+96 slots): :10, :20, :40, :50 per hour
 */
function assignFlexibleSlot(cron: string, existingSchedules: Schedule[]): string {
  const parts = cron.split(' ');
  const counts = new Map<string, number>();
  for (const s of existingSchedules) {
    if (!s.flexible || !s.assignedCron) continue;
    const ap = s.assignedCron.split(' ');
    const key = `${ap[0]}_${ap[1]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const phases: number[][] = [[0], [30], [10, 20, 40, 50]];
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
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      const result = [...parts];
      result[0] = String(chosen.minute);
      result[1] = String(chosen.hour);
      return result.join(' ');
    }
  }
  // All 144 slots saturated — fall back to random minute
  const result = [...parts];
  result[0] = String(Math.floor(Math.random() * 60));
  return result.join(' ');
}

function createSchedule(
  filePath: string,
  args: unknown[],
  flexible: boolean,
  ittHome: string | null,
  workspacesDir?: string,
): string {
  const cron        = args[0] as string;
  const intentName  = args[1] as string;
  const inputs      = (args[2] as Record<string, string>) ?? {};
  const rawWorkdir  = args[3] as string | null | undefined;
  const workdir     = rawWorkdir
    ? rawWorkdir
    : (() => {
        const safeName = intentName.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!workspacesDir) throw new FailableError('Schedule workdir or workspacesDir must be provided');
        const dir = path.join(workspacesDir, safeName, crypto.randomUUID().slice(0, 8));
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      })();

  // Parse namespace from intentName (e.g. "docs.generateDocs" → name="generateDocs", nsPath="docs")
  const dotIdx = intentName.lastIndexOf('.');
  const name   = dotIdx === -1 ? intentName : intentName.slice(dotIdx + 1);
  const nsPath = dotIdx === -1 ? '' : intentName.slice(0, dotIdx).replace(/\./g, path.sep);

  let resolvedIttPath: string;
  if (ittHome) {
    const found = resolveBrainPath(name, nsPath, ittHome);
    if (!found) throw new FailableError(`Intent not found in Brain: '${intentName}'. Run: itt install <file>`);
    resolvedIttPath = found;
  } else {
    // No ittHome configured — store bare filename (backward compat)
    resolvedIttPath = `${name}.itt.json`;
  }

  const schedules = readSchedules(filePath);
  const assignedCron = flexible ? assignFlexibleSlot(cron, schedules) : undefined;
  const s: Schedule = {
    id: crypto.randomUUID(),
    name: `${name}_scheduled`,
    cron,
    ittPath: resolvedIttPath,
    workdir,
    inputs,
    enabled: true,
    ...(flexible ? { flexible: true, assignedCron } : {}),
  };
  schedules.push(s);
  writeSchedules(filePath, schedules);
  return s.id;
}

export type SysCallFn = (method: string, args: unknown[]) => Promise<unknown>;

export type SysExecutorConfig =
  | { mode: 'direct'; entityManager: EntityStore; intentsDir?: string; scheduleFilePath?: string; ittHome?: string; workspacesDir?: string }
  | { mode: 'ipc';    sysCall: SysCallFn };

export type SysExecutorFn = (
  node: CallNode,
  inputs: Record<string, Value>,
  caller: SystemCaller,
) => Promise<{ outputs: Record<string, Value> }>;

const SYS_WRITE_METHODS = new Set([
  'createEntity', 'updateEntityField',
  'deleteEntity', 'deleteClass',
  'scheduleIntent', 'scheduleFlexibleIntent', 'cancelSchedulor',
  'updateEntityTag', 'defineTagDimension', 'addTagEnumValue',
]);

export function createSysExecutor(config: SysExecutorConfig): SysExecutorFn {
  return async (node: CallNode, inputs: Record<string, Value>, caller: SystemCaller) => {
    const method = node.callee!;
    const paramOrder = Object.hasOwn(SYS_METHOD_PARAMS, method) ? SYS_METHOD_PARAMS[method] : undefined;
    if (!paramOrder) throw new FailableError(`Unknown _by_sys method: '${method}'`);

    if (SYS_WRITE_METHODS.has(method) && caller.caller !== 'executor_sys') {
      throw new FailableError(
        `Permission denied: caller '${caller.caller}' may not call '${method}'`,
      );
    }

    const args = paramOrder.map(p => inputs[p] ?? null);

    let result: unknown;
    result = config.mode === 'ipc'
      ? await config.sysCall(method, args)
      : await callDirect(method, args, config);

    const outputs: Record<string, Value> = {};
    const declaredOutputs = Object.keys(node.outputs ?? {});
    if (declaredOutputs.length === 1) {
      outputs[declaredOutputs[0]] = result as Value;
    } else if (declaredOutputs.length > 1 && result !== null && typeof result === 'object') {
      for (const key of declaredOutputs) {
        outputs[key] = (result as Record<string, Value>)[key];
      }
    }
    return { outputs };
  };
}

async function callDirect(
  method: string,
  args: unknown[],
  config: Extract<SysExecutorConfig, { mode: 'direct' }>,
): Promise<unknown> {
  const em = config.entityManager;
  switch (method) {
    case 'createEntity':      return em.createEntity(args[0] as string, args[1] as string, args[2] as Record<string, unknown>, args[3] as string, args[4] as Record<string, string>);
    case 'getEntityField':    return em.getEntityField(args[0] as string, args[1] as string);
    case 'updateEntityField': em.updateEntityField(args[0] as string, args[1] as string, args[2], args[3] as number); return undefined;
    case 'queryEntities':     return em.queryEntities(args[0] as string);
    case 'deleteEntity':      return em.deleteEntity(args[0] as string);
    case 'deleteClass':       return em.deleteClass(args[0] as string);
    case 'getEntity':         return em.getEntity(args[0] as string);
    case 'queryClasses':      return em.queryClasses();
    case 'queryClassInfo':    return em.queryClassInfo(args[0] as string);
    case 'scheduleIntent': {
      const fp = schedulePath(config);
      return createSchedule(fp, args, false, config.ittHome ?? null, config.workspacesDir);
    }
    case 'scheduleFlexibleIntent': {
      const fp = schedulePath(config);
      return createSchedule(fp, args, true, config.ittHome ?? null, config.workspacesDir);
    }
    case 'querySchedulors': {
      const fp = schedulePath(config);
      return readSchedules(fp).map(s => {
        const base = path.basename(s.ittPath);
        const intentName = base.endsWith('.itt.impl.json')
          ? base.slice(0, -'.itt.impl.json'.length)
          : base.endsWith('.itt.json')
            ? base.slice(0, -'.itt.json'.length)
            : base;
        return { id: s.id, intentName, cron: s.cron, params: s.inputs };
      });
    }
    case 'cancelSchedulor': {
      const fp = schedulePath(config);
      const schedules = readSchedules(fp);
      const next = schedules.filter(s => s.id !== (args[0] as string));
      if (next.length === schedules.length) throw new FailableError('Scheduler not found');
      writeSchedules(fp, next);
      return true;
    }
    case 'querySchedulorInfo': {
      const fp = schedulePath(config);
      const s = readSchedules(fp).find(s => s.id === (args[0] as string));
      if (!s) throw new FailableError('Scheduler not found');
      const base = path.basename(s.ittPath);
      const intentName = base.endsWith('.itt.impl.json')
        ? base.slice(0, -'.itt.impl.json'.length)
        : base.endsWith('.itt.json')
          ? base.slice(0, -'.itt.json'.length)
          : base;
      return { id: s.id, intentName, cron: s.cron, params: s.inputs };
    }
    case 'queryIntents':      return scanIntents(config);
    case 'queryIntentInfo':   return getIntentInfo(args[0] as string, config);
    case 'updateEntityTag':   em.updateEntityTag(args[0] as string, args[1] as string, args[2] as string); return undefined;
    case 'defineTagDimension': em.defineTagDimension(
      args[0] as string,
      args[1] as 'class' | 'entity',
      args[2] as 'enum' | 'bool',
      args[3] as string[],
      args[4] as boolean | undefined,
      args[5] as boolean | undefined,
      args[6] as string | undefined,
      args[7] as string | undefined,
    ); return undefined;
    case 'addTagEnumValue':   em.addTagEnumValue(args[0] as string, args[1] as string); return undefined;
    case 'getTagDefinitions': return em.getTagDefinitions();
    case 'queryClassesByTags': return em.queryClassesByTags(args[0] as import('./entity-store').TagCondition[]);
    case 'queryEntitiesByTags': return em.queryEntitiesByTags(args[0] as string, args[1] as import('./entity-store').TagCondition[]);
    case 'queryIntentsByTags': return em.queryIntentsByTags(args[0] as import('./entity-store').TagCondition[]);
    default: throw new FailableError(`Unknown _by_sys method: '${method}'`);
  }
}

function scanIntents(config: Extract<SysExecutorConfig, { mode: 'direct' }>): { name: string; desc: string }[] {
  const dir = config.intentsDir;
  if (!dir) throw new FailableError('queryIntents: intentsDir not configured');
  const byName = new Map<string, { name: string; desc: string; hasImpl: boolean }>();
  const scan = (d: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try { entries = fs.readdirSync(d); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(d, entry);
      let stat: ReturnType<typeof fs.statSync>;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (stat.isDirectory()) { scan(fullPath, depth + 1); continue; }
      let name: string; let hasImpl: boolean;
      if (entry.endsWith('.itt.impl.json')) { name = entry.slice(0, -'.itt.impl.json'.length); hasImpl = true; }
      else if (entry.endsWith('.itt.json')) { name = entry.slice(0, -'.itt.json'.length); hasImpl = false; }
      else continue;
      if (byName.get(name)?.hasImpl) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as { description?: string };
        byName.set(name, { name, desc: parsed.description ?? '', hasImpl });
      } catch { /* skip unreadable */ }
    }
  };
  scan(dir, 0);
  return Array.from(byName.values()).map(({ name, desc }) => ({ name, desc }));
}

function findIntentPath(name: string, dir: string, depth = 0): string | null {
  if (depth > 3) return null;
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let stat: ReturnType<typeof fs.statSync>;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) {
      const found = findIntentPath(name, fullPath, depth + 1);
      if (found) return found;
      continue;
    }
    if (entry === `${name}.itt.impl.json` || entry === `${name}.itt.json`) return fullPath;
  }
  return null;
}

function getIntentInfo(
  name: string,
  config: Extract<SysExecutorConfig, { mode: 'direct' }>,
): { name: string; desc: string; inputs: Record<string, unknown>; outputs: Record<string, unknown> } {
  const dir = config.intentsDir;
  if (!dir) throw new FailableError('queryIntentInfo: intentsDir not configured');
  const safeName = path.basename(name);
  const found = findIntentPath(safeName, dir);
  if (!found) throw new FailableError('Intent not found');
  const parsed = JSON.parse(fs.readFileSync(found, 'utf-8')) as {
    description?: string;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
  };
  return { name: safeName, desc: parsed.description ?? '', inputs: parsed.inputs ?? {}, outputs: parsed.outputs ?? {} };
}
