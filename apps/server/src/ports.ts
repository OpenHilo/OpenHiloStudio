import type { WorkerSupervisor } from '@openhilo/platform-services/worker-supervisor';
import type { WorkerSystemHost } from '@openhilo/platform-services/worker-system-host';
import type { ScheduleService } from '@openhilo/platform-services/schedule-service';
import type { SessionInput, SessionStep } from '@openhilo/platform-services/generation-session';

export interface ServerPaths { runsDir: string; intentsDir: string; brainDir: string; workspacesDir: string }
export type WorkerPort = Pick<WorkerSupervisor, 'forkRun' | 'forkResume' | 'abort' | 'isActive' | 'activeRunIds' | 'answerAiQuestion'> &
  Partial<Pick<WorkerSupervisor, 'stopState' | 'refreshStops'>> &
  Pick<WorkerSystemHost, 'queryIntents' | 'queryIntentInfo'> & { scheduleService: Pick<ScheduleService, 'list' | 'delete'> };
export interface ConfigurationPort { read(): unknown | Promise<unknown>; update(input: unknown): unknown | Promise<unknown> }
export interface GenerationPort {
  stop?(id: string): Promise<SessionStep>;
  removeHistory?(id: string): Promise<void>;
  restoreHistory?(id: string): Promise<void>;
  start(input: { naturalLanguage: string; workspace?: string; requestId?: string }): Promise<{ sessionId: string; step: SessionStep }>;
  respond(id: string, input: SessionInput): Promise<SessionStep>;
  read(id: string): Promise<SessionStep | undefined | null>;
  list?(options: { offset: number; limit: number; group?: import('@openhilo/platform-services/generation-service').GenerationGroup | 'recent' }): Promise<import('@openhilo/platform-services/generation-service').GenerationList>;
}

/** Structural ports allow alternative storage and process hosts without inheriting implementation classes. */
export type EntityPort = Pick<import('@openhilo/platform-services/entity-service').EntityService, keyof import('@openhilo/platform-services/entity-service').EntityService>;
export type FilterPort = Pick<import('@openhilo/platform-services/filter-service').FilterService, 'list' | 'create' | 'delete'>;
export type SchedulePort = Pick<ScheduleService, 'list' | 'create' | 'patch' | 'delete'>;
export type SchedulerPort = Pick<import('@openhilo/platform-services/scheduler').Scheduler, 'register' | 'update' | 'unregister'> &
  Partial<Pick<import('@openhilo/platform-services/scheduler').Scheduler, 'timing'>>;
export type BroadcasterPort = Pick<import('@openhilo/platform-services/broadcaster').Broadcaster, 'subscribe' | 'unsubscribe' | 'close'>;
