/** Platform system capabilities exposed to a supervised worker. No process or AI configuration. */
import * as path from 'path';
import {qualifiedWorkflowName} from './worker-run-path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { EntityStore } from './entity-store';
import type { WorkerMessage } from './worker-protocol';
import { FailableError } from '@openhilo/runtime-contracts';
import { parseCallee, findITTFiles } from './brain-snapshot';

export interface WorkerScheduleService {
  list(): Promise<Array<{ id: string; ittPath: string; cron: string; inputs: Record<string, string> }>>;
  delete(id: string): Promise<unknown>;
  create(input: { name: string; cron: string; ittPath: string; workdir: string; inputs: Record<string, string>; flexible?: boolean }): Promise<{ id: string }>;
}
export interface WorkerSystemHostOptions {
  entityManager: EntityStore;
  scheduleService: WorkerScheduleService;
  intentsDir: string;
  workspacesDir: string;
}
export class WorkerSystemHost {
  private readonly entityManager: EntityStore;
  private readonly scheduleService: WorkerScheduleService;
  private readonly intentsDir: string;
  private readonly workspacesDir: string;
  constructor(options: WorkerSystemHostOptions) {
    if (!path.isAbsolute(options.intentsDir) || !path.isAbsolute(options.workspacesDir)) throw new Error('Worker system directories must be explicit absolute paths');
    this.entityManager = options.entityManager;
    this.scheduleService = options.scheduleService;
    this.intentsDir = options.intentsDir;
    this.workspacesDir = options.workspacesDir;
  }

  async handleSystemCall(
    worker: { send(message: WorkerMessage): unknown },
    msg: Extract<WorkerMessage, { type: 'sys_call' }>,
  ): Promise<void> {
    try {
      const em = this.entityManager;
      let result: unknown;
      switch (msg.method) {
        case 'defineClass':         result = em.defineClass(msg.args[0] as string, msg.args[1], msg.args[2] as string, (msg.args[3] as Record<string, string>) ?? {}); break;
        case 'createEntity':        result = em.createEntity(msg.args[0] as string, msg.args[1] as string, msg.args[2] as Record<string, unknown>, msg.args[3] as string, (msg.args[4] as Record<string, string>) ?? {}); break;
        case 'getEntityField':      result = em.getEntityField(msg.args[0] as string, msg.args[1] as string); break;
        case 'updateEntityField':   em.updateEntityField(msg.args[0] as string, msg.args[1] as string, msg.args[2], msg.args[3] as number); result = undefined; break;
        case 'queryEntities':       result = em.queryEntities(msg.args[0] as string); break;
        case 'deleteEntity':        result = em.deleteEntity(msg.args[0] as string); break;
        case 'deleteClass':         result = em.deleteClass(msg.args[0] as string); break;
        case 'queryClasses':        result = em.queryClasses(); break;
        case 'queryClassInfo':      result = em.queryClassInfo(msg.args[0] as string); break;
        case 'querySchedulors':     result = await this._querySchedulors(); break;
        case 'cancelSchedulor':     result = await this.scheduleService.delete(msg.args[0] as string); break;
        case 'querySchedulorInfo':  result = await this._querySchedulorInfo(msg.args[0] as string); break;
        case 'queryIntents':        result = await this.queryIntents(); break;
        case 'queryIntentInfo':     result = await this.queryIntentInfo(msg.args[0] as string); break;
        case 'queryIntentsByTags':  result = await this.queryIntentsByTags(msg.args[0] as import('./entity-store').TagCondition[]); break;
        case 'getEntity':           result = em.getEntity(msg.args[0] as string); break;
        case 'updateEntityTag':     em.updateEntityTag(msg.args[0] as string, msg.args[1] as string, msg.args[2] as string); result = undefined; break;
        case 'defineTagDimension':  em.defineTagDimension(msg.args[0] as string, msg.args[1] as 'class' | 'entity', msg.args[2] as 'enum' | 'bool', msg.args[3] as string[], msg.args[4] as boolean | undefined, msg.args[5] as boolean | undefined, msg.args[6] as string | undefined, msg.args[7] as string | undefined); result = undefined; break;
        case 'addTagEnumValue':     em.addTagEnumValue(msg.args[0] as string, msg.args[1] as string); result = undefined; break;
        case 'getTagDefinitions':   result = em.getTagDefinitions(); break;
        case 'queryClassesByTags':  result = em.queryClassesByTags(msg.args[0] as import('./entity-store').TagCondition[]); break;
        case 'queryEntitiesByTags': result = em.queryEntitiesByTags(msg.args[0] as string, msg.args[1] as import('./entity-store').TagCondition[]); break;
        case 'scheduleIntent': {
          const rawWorkdir = msg.args[3] as string | null | undefined;
          let workdir: string;
          if (rawWorkdir) {
            workdir = rawWorkdir;
          } else {
            const intentName = String(msg.args[1]).replace(/[^a-zA-Z0-9_-]/g, '_');
            workdir = path.join(this.workspacesDir, intentName, crypto.randomUUID().slice(0, 8));
            fs.mkdirSync(workdir, { recursive: true });
          }
          const sched = await this.scheduleService.create({
            name: `${String(msg.args[1])}_scheduled`,
            cron: msg.args[0] as string,
            ittPath: this.resolveIttPath(String(msg.args[1])),
            workdir,
            inputs: (msg.args[2] as Record<string, string>) ?? {},
          });
          result = sched.id; break;
        }
        case 'scheduleFlexibleIntent': {
          const rawWorkdir = msg.args[3] as string | null | undefined;
          let workdir: string;
          if (rawWorkdir) {
            workdir = rawWorkdir;
          } else {
            const intentName = String(msg.args[1]).replace(/[^a-zA-Z0-9_-]/g, '_');
            workdir = path.join(this.workspacesDir, intentName, crypto.randomUUID().slice(0, 8));
            fs.mkdirSync(workdir, { recursive: true });
          }
          const sched = await this.scheduleService.create({
            name: `${String(msg.args[1])}_scheduled`,
            cron: msg.args[0] as string,
            ittPath: this.resolveIttPath(String(msg.args[1])),
            workdir,
            inputs: (msg.args[2] as Record<string, string>) ?? {},
            flexible: true,
          });
          result = sched.id; break;
        }
        default: throw new Error(`Unknown sys method: '${msg.method}'`);
      }
      worker.send({ type: 'sys_response', reqId: msg.reqId, result });
    } catch (err) {
      worker.send({ type: 'sys_response', reqId: msg.reqId, error: (err as Error).message });
    }
  }

  private async _querySchedulors(): Promise<{ id: string; intentName: string; cron: string; params: Record<string, string> }[]> {
    const schedules = await this.scheduleService.list();
    return schedules.map(s => {
      const intentName = qualifiedWorkflowName(s.ittPath, this.intentsDir);
      return { id: s.id, intentName, cron: s.cron, params: s.inputs };
    });
  }

  private async _querySchedulorInfo(id: string): Promise<{ id: string; intentName: string; cron: string; params: Record<string, string> }> {
    const schedules = await this.scheduleService.list();
    const s = schedules.find(s => s.id === id);
    if (!s) throw new FailableError('Scheduler not found');
    const intentName = qualifiedWorkflowName(s.ittPath, this.intentsDir);
    return { id: s.id, intentName, cron: s.cron, params: s.inputs };
  }

  async queryIntents(): Promise<{ name: string; desc: string; ittPath: string; relativeIttPath: string }[]> {
    const byName = new Map<string, { name: string; desc: string; ittPath: string; hasImpl: boolean }>();

    if (!fs.existsSync(this.intentsDir)) return [];

    // Flat layout: intents/<ns>/<intentName>/<intentName>.{itt.json,itt.impl.json}
    for (const nsEntry of fs.readdirSync(this.intentsDir)) {
      const nsPath = path.join(this.intentsDir, nsEntry);
      let nsStat: fs.Stats;
      try { nsStat = fs.statSync(nsPath); } catch { continue; }
      if (!nsStat.isDirectory()) continue;

      for (const intentEntry of fs.readdirSync(nsPath)) {
        const intentDir = path.join(nsPath, intentEntry);
        let intentStat: fs.Stats;
        try { intentStat = fs.statSync(intentDir); } catch { continue; }
        if (!intentStat.isDirectory()) continue;

        const implPath = path.join(intentDir, `${intentEntry}.itt.impl.json`);
        const leafPath = path.join(intentDir, `${intentEntry}.itt.json`);
        const hasImpl = fs.existsSync(implPath);
        const ittPath = hasImpl ? implPath : leafPath;

        if (!fs.existsSync(ittPath)) continue;

        const name = `${nsEntry}.${intentEntry}`;
        const existing = byName.get(name);
        if (existing && existing.hasImpl && !hasImpl) continue; // prefer .impl
        try {
          const parsed = JSON.parse(fs.readFileSync(ittPath, 'utf8')) as { description?: string };
          byName.set(name, { name, desc: parsed.description ?? '', ittPath, hasImpl });
        } catch {
          // skip unreadable files
        }
      }
    }

    return Array.from(byName.values()).map(({ name, desc, ittPath }) => ({ name, desc, ittPath, relativeIttPath: path.relative(this.intentsDir, ittPath).split(path.sep).join('/') }));
  }

  async queryIntentInfo(name: string): Promise<{ name: string; desc: string; inputs: Record<string, unknown>; outputs: Record<string, unknown> }> {
    // Use queryIntents() to resolve the correct path (handles flat and subdirectory layouts)
    const all = await this.queryIntents();
    const found = all.find(i => i.name === name);
    if (!found) throw new FailableError('Intent not found');
    const parsed = JSON.parse(fs.readFileSync(found.ittPath, 'utf8')) as {
      description?: string;
      inputs?: Record<string, unknown>;
      outputs?: Record<string, unknown>;
    };
    return { name, desc: parsed.description ?? '', inputs: parsed.inputs ?? {}, outputs: parsed.outputs ?? {} };
  }

  async queryIntentsByTags(
    conditions: import('./entity-store').TagCondition[],
  ): Promise<{ name: string; desc: string; tags: Record<string, string> }[]> {
    return this.entityManager.queryIntentsByTags(conditions);
  }

  /**
   * Resolve a logical intent name (e.g. "docs.generateDocs") to a relative path
   * (e.g. "docs/generateDocs/generateDocs.itt.json") for storage in schedules.
   */
  resolveIttPath(logicalName: string): string {
    const { intentName, nsPath } = parseCallee(logicalName, {});
    const found = findITTFiles(intentName, nsPath, this.intentsDir);
    if (found.length === 0) {
      throw new FailableError(`Intent not found: ${logicalName}`);
    }
    return path.relative(this.intentsDir, found[0]);
  }
}
