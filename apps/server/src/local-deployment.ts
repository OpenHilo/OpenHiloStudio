/** Reusable local composition root. Concrete AI, applications and clocks remain caller-owned choices. */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createServer, type ServerOptions } from './index';
import { validateLocalSchedule } from './validate-local-schedule';
import { createDeploymentLifecycle } from './deployment-lifecycle';
import { EntityStore } from '@openhilo/platform-services/entity-store';
import { acquireDeploymentOwnership } from '@openhilo/platform-services/deployment-ownership';
import { EntityService } from '@openhilo/platform-services/entity-service';
import { WorkerSupervisor, type WorkerSupervisorOptions } from '@openhilo/platform-services/worker-supervisor';
import { WorkerSystemHost } from '@openhilo/platform-services/worker-system-host';
import { Broadcaster } from '@openhilo/platform-services/broadcaster';
import { FilterService } from '@openhilo/platform-services/filter-service';
import { ScheduleService } from '@openhilo/platform-services/schedule-service';
import { Scheduler, type SchedulerOptions } from '@openhilo/platform-services/scheduler';
import { createGenerationService } from '@openhilo/platform-services/generation-service';
import { GenerationSession, type GenerationConfig, type SerializedSession } from '@openhilo/platform-services/generation-session';
import { createFileSessionStorage } from '@openhilo/platform-services/generation-storage';
import { createGenerationPipeline, type GenerationPipelineConfig } from '@openhilo/platform-services/generation-pipeline';
import { WorktreePool } from '@openhilo/platform-services/worktree-pool';
import { createPlatformToolHost } from '@openhilo/platform-services/tools';
import { genericGenerationPolicy } from '@openhilo/generation-contracts';
import type { AiTaskExecutor } from '@openhilo/ai-contracts';

export interface LocalDeploymentOptions extends Pick<ServerOptions,
  'configuration' | 'application' | 'capabilities' | 'publicDir' | 'logger' | 'corsOrigin' | 'allowedHosts' | 'registerExtensions'> {
  /** Existing home with a separately initialized, committed brain Git repository. No default HOME. */
  home: string;
  aiExecutor: AiTaskExecutor;
  launch: WorkerSupervisorOptions['launch'];
  stopWorker?: WorkerSupervisorOptions['stopWorker'];
  beforeResume?: WorkerSupervisorOptions['beforeResume'];
  clock: SchedulerOptions['clock'];
  /** Optional application initialization, explicitly chosen by the deployment. */
  createStore?(databasePath: string): EntityStore;
  generation?: {
    policy?: GenerationConfig['generationPolicy'];
    host?: GenerationConfig['aiHost'];
    compileSource?: GenerationPipelineConfig['compileSource'];
    compileProgram?: GenerationPipelineConfig['compileProgram'];
    legacyEntryTags?: boolean;
    maxClarificationRounds?: number;
    maxFeedbackRounds?: number;
    poolSize?: number;
  };
  onBackgroundError?(error: unknown): void;
}

/** Construct a ready app without listening or starting schedule timers. Close via app.close(). */
export async function createLocalDeployment(options: LocalDeploymentOptions) {
  if (!path.isAbsolute(options.home) || !fs.statSync(options.home).isDirectory()) throw new Error('Local deployment requires an existing absolute home directory');
  const home = fs.realpathSync(options.home);
  const paths = { runsDir: path.join(home, 'runs'), intentsDir: path.join(home, 'intents'), brainDir: path.join(home, 'brain'), workspacesDir: path.join(home, 'workspaces') };
  if (!fs.existsSync(path.join(paths.brainDir, '.git'))) throw new Error('Initialize and commit the deployment brain repository before opening it');
  if (!options.aiExecutor?.id) throw new Error('Local deployment requires an explicit AI executor');
  const ownership = acquireDeploymentOwnership(home);
  let closeStore: (() => void) | undefined;
  let lifecycle: ReturnType<typeof createDeploymentLifecycle> | undefined;
  try {
    for (const value of Object.values(paths)) fs.mkdirSync(value, { recursive: true });
    const store = options.createStore?.(path.join(home, 'entities.db')) ?? new EntityStore(path.join(home, 'entities.db'));
    closeStore = () => { store.close(); ownership.close(); };
    const schedules = new ScheduleService(path.join(home, 'schedules.json'), { validateCron: expression => options.clock.validate(expression), validateTarget: schedule => validateLocalSchedule(schedule, paths.intentsDir) });
    const broadcaster = new Broadcaster();
    const system = new WorkerSystemHost({ entityManager: store, scheduleService: schedules, intentsDir: paths.intentsDir, workspacesDir: paths.workspacesDir });
    const supervisor = new WorkerSupervisor({ broadcaster, runsDir: paths.runsDir, launch: options.launch, stopWorker: options.stopWorker, beforeResume: options.beforeResume,
      handleSystemCall: (child, message) => system.handleSystemCall(child, message) });
    const workers = Object.assign(supervisor, {
      queryIntents: () => system.queryIntents(), queryIntentInfo: (name: string) => system.queryIntentInfo(name), scheduleService: schedules,
    });
    const scheduler = new Scheduler({ repository: schedules, clock: options.clock, launch: input => workers.forkRun(input),
      ...(options.onBackgroundError ? { onError: options.onBackgroundError } : {}) });
    const settings = options.generation;
    const pool = new WorktreePool({ brainDir: paths.brainDir, poolDir: path.join(home, 'pool'), size: settings?.poolSize ?? 3 });
    const services = {
      ...createGenerationPipeline({ brainDir: paths.brainDir, intentsDir: paths.intentsDir, compileSource: settings?.compileSource, compileProgram: settings?.compileProgram }),
      checkoutWorktree: (id: string) => pool.checkout(id),
      assertWorktreeOwner: (dir: string, id: string) => pool.assertOwner(dir, id),
      returnWorktree: (dir: string, id: string) => pool.release(dir, id),
    };
    const sessionsDir = path.join(home, 'sessions'), storage = createFileSessionStorage(sessionsDir);
    const aiHost: NonNullable<GenerationConfig['aiHost']> = settings?.host ?? (() => ({ tools: createPlatformToolHost(store, { intentsDir: paths.intentsDir, allowDefineClass: true }) }));
    // Saved live attempts are not automatically replayed or reconnected by this generic host.
    // Review candidates and controlled workflow suspension have separate recovery paths.
    const inspect = (saved: SerializedSession) => GenerationSession.fromJSON(
      ['cc_running', 'cc_waiting_for_answer', 'auto_fixing'].includes(saved.phase) && (saved.round > 0 || saved.naturalLanguage !== '')
        ? { ...saved, phase: 'error', lastError: { retryable: false, message: 'Generation was interrupted by a host restart. Inspect its retained workspace and question history before starting a new session; no attempt was replayed.' } }
        : saved);
    const generation = createGenerationService({
      storage,
      create(input, id = randomUUID()) {
        if (input.workspace !== undefined && path.resolve(input.workspace) !== paths.brainDir) throw new Error('This deployment generates in its configured brain workspace');
        return GenerationSession.create({ workspace: paths.brainDir, sessionDir: path.join(sessionsDir, id), publicationDir: paths.intentsDir,
          intentsDir: paths.intentsDir, dbPath: path.join(home, 'entities.db'), entityManager: store,
          maxClarificationRounds: settings?.maxClarificationRounds ?? 2, maxFeedbackRounds: settings?.maxFeedbackRounds ?? 5,
          legacyEntryTags: settings?.legacyEntryTags, services, aiExecutor: options.aiExecutor, aiHost, generationPolicy: settings?.policy }, id);
      },
      inspect,
      restore(saved) {
        // Even retiring a terminal session persists its snapshot. Reject an old
        // absolute sessionDir before taking ownership of it.
        if (typeof saved.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(saved.id) || saved.sessionDir !== path.join(sessionsDir, saved.id)) throw new Error('Saved generation paths require explicit migration before continuation');
        const session = inspect(saved), step = session.currentStep();
        if (step.phase === 'done' || step.phase === 'error' && !step.retryable) return session;
        // Never continue a candidate under another implementation or policy.
        if (saved.aiExecutorId !== options.aiExecutor.id && (saved.round > 0 || saved.naturalLanguage !== '')) throw new Error('Saved generation executor must be explicitly rebound');
        if (saved.config.workspace !== paths.brainDir || saved.config.publicationDir !== paths.intentsDir) throw new Error('Saved generation paths require explicit migration before continuation');
        session.bindAiExecutor(options.aiExecutor, aiHost);
        session.bindGenerationPolicy(settings?.policy ?? genericGenerationPolicy);
        session.bindServices(services);
        return session;
      },
      onBackgroundError: options.onBackgroundError,
    });
    lifecycle = createDeploymentLifecycle({ scheduler, workers, generation, store: { close: closeStore } });
    const owned = lifecycle;
    let start: Promise<void> | undefined, closed = false;
    const app = await createServer({ paths, workers, broadcaster, schedules, scheduler, generation,
      entities: new EntityService(store), filters: new FilterService(path.join(home, 'filters.json')),
      configuration: options.configuration, application: options.application, capabilities: options.capabilities,
      publicDir: options.publicDir, logger: options.logger, corsOrigin: options.corsOrigin, allowedHosts: options.allowedHosts,
      async registerExtensions(app) {
        app.addHook('preClose', async () => { closed = true; await owned.quiesce(); });
        await options.registerExtensions?.(app);
      }, close: owned.close,
    });
    return { app, home, paths, store, workers, schedules, scheduler, generation, storage,
      /** Call after listen succeeds. It also supports injection-only hosts. */
      startSchedules(): Promise<void> {
        if (closed) return Promise.reject(new Error('Local deployment is closed'));
        return start ??= scheduler.start().catch(async error => { closed = true; await app.close(); throw error; });
      },
      async close(): Promise<void> { closed = true; await app.close(); },
    };
  } catch (error) {
    if (lifecycle) await lifecycle.close();
    else if (closeStore) closeStore();
    else ownership.close();
    throw error;
  }
}
