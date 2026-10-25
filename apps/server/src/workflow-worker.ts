import * as fs from 'fs';
import * as path from 'path';
import type { ExecutorFn } from '@openhilo/runtime/execution-engine';
import type { JsonObject } from '@openhilo/ai-contracts';
import { AbortError } from '@openhilo/runtime-contracts';
import { StudioHumanExecutor } from '@openhilo/human-studio';
import { startRun, resumeRun, type RunComposition, type RunContext, type RunResources } from '@openhilo/runtime/run-service';
import { createWorkerAiHost } from '@openhilo/platform-services/worker-ai-host';
import { createWorkerSystemClient } from '@openhilo/platform-services/worker-system-client';
import { createSysExecutor, type SysExecutorFn } from '@openhilo/platform-services/system-executor';
import { resolveRunOpts } from '@openhilo/platform-services/worker-run-path';
import { sendWorkerMessage, createWorkerEventForwarder } from '@openhilo/platform-services/worker-protocol';
import type { ForkRunOpts, ForkResumeOpts } from '@openhilo/platform-services/worker-supervisor';

export interface WorkerPorts {
  aiHost: ReturnType<typeof createWorkerAiHost>['host'];
  onAiExecution: ReturnType<typeof createWorkerAiHost>['attach'];
  sysExecutor: ExecutorFn;
  /** Trusted composition may attach private caller metadata without owning another IPC transport. */
  systemExecutor: SysExecutorFn;
}
export interface WorkflowWorkerComposition extends Omit<RunComposition, 'createResources' | 'onEvent'> {
  runsDir: string;
  intentsDir: string;
  receipt?: JsonObject;
  populateSnapshot(context: RunContext): void | Promise<void>;
  createResources(context: RunContext, ports: WorkerPorts): RunResources | Promise<RunResources>;
  createTools?: NonNullable<Parameters<typeof createWorkerAiHost>[0]>['createTools'];
  /** Releases resources allocated by the composition factory, even if validation/startup fails. */
  close?(): void | Promise<void>;
}
export type WorkflowWorkerRequest = { kind: 'run-worker'; input: ForkRunOpts } | { kind: 'resume-worker'; input: ForkResumeOpts };
export type WorkflowWorkerFactory = (request: WorkflowWorkerRequest) => WorkflowWorkerComposition | Promise<WorkflowWorkerComposition>;

/** Execute one parent request using explicit runtime and platform services. Does not choose an AI or application. */
export async function runWorkflowWorker(request: WorkflowWorkerRequest, createComposition: WorkflowWorkerFactory): Promise<void> {
  const composition = await createComposition(request);
  let ai: ReturnType<typeof createWorkerAiHost> | undefined;
  let system: ReturnType<typeof createWorkerSystemClient> | undefined;
  const events = createWorkerEventForwarder(() => ai?.close());
  let cleanup: Promise<void> | undefined;
  const close = () => cleanup ??= (async () => {
    try { await events.drain().catch(() => {}); await ai?.close(); }
    finally { system?.close(); await composition.close?.(); }
  })();
  try {
    if (!path.isAbsolute(composition.runsDir) || !path.isAbsolute(composition.intentsDir)) throw new Error('Worker directories must be explicit absolute paths');
    ai = createWorkerAiHost({ createTools: composition.createTools });
    system = createWorkerSystemClient();
    let hosted = false;
    const startHost = (runDir: string) => { if (!hosted) { ai!.start(runDir); hosted = true; } };
    const callSystem = createSysExecutor({ mode: 'ipc', sysCall: system.call });
    const ports: WorkerPorts = { aiHost: ai.host, onAiExecution: ai.attach, systemExecutor: callSystem,
      sysExecutor: async (node, inputs) => {
        if (node.type !== 'call' || node.executor !== 'sys') throw new Error('System executor requires a system call node');
        // Trusted deployment composition supplies this role; workflow/HTTP input cannot choose it.
        return callSystem(node, inputs, { caller: 'executor_sys' });
      },
    };
    const common: RunComposition = {
      aiRoutingIdentity: composition.aiRoutingIdentity,
      humanMode: composition.humanMode ?? 'suspend', extensions: composition.extensions,
      humanExecutor: composition.humanExecutor,
      allowLegacyExtensionRestore: composition.allowLegacyExtensionRestore, checkpointsEnabled: composition.checkpointsEnabled,
      async createResources(context) {
        startHost(context.runDir);
        const resources = await composition.createResources(context, ports);
        return {
          executor(node, inputs, executionContext) {
            // Drain an already-started effect, but never admit another after a
            // durable stop request or loss of the supervising parent.
            if (process.connected === false || fs.existsSync(path.join(context.runDir, 'stop-request.json'))) {
              throw new AbortError('Workflow stopped before the next execution step');
            }
            return resources.executor(node, inputs, executionContext);
          },
          humanExecutor: resources.humanExecutor ?? new StudioHumanExecutor(), close: () => resources.close?.(),
        };
      },
      onEvent: events.publish,
    };
    let result;
    if (request.kind === 'run-worker') {
      const input = request.input;
      if (!input || typeof input.ittPath !== 'string' || typeof input.workdir !== 'string' || !path.isAbsolute(input.workdir)) throw new Error('Worker requires ittPath and an absolute workdir');
      if (!path.isAbsolute(input.ittPath) && (path.normalize(input.ittPath) === '..' || path.normalize(input.ittPath).startsWith(`..${path.sep}`))) throw new Error('Relative ittPath must stay within intentsDir');
      const resolved = resolveRunOpts(input.ittPath, composition.intentsDir);
      if (!resolved || !fs.statSync(resolved.entryFile).isFile()) throw new Error(`Intent file not found: ${input.ittPath}`);
      result = await startRun({ ...common, ...resolved, workdir: input.workdir, runsDir: composition.runsDir, inputs: input.inputs ?? {}, inputEncoding: input.inputEncoding,
        receipt: { ...composition.receipt, ittPath: input.ittPath, inputs: input.inputs ?? {}, triggeredBy: input.triggeredBy ?? 'manual' },
        populateSnapshot: context => composition.populateSnapshot(context),
        async onRunCreated(runId, runDir) { startHost(runDir); await sendWorkerMessage({ type: 'started', runId, runDir }); },
      });
    } else {
      if (!request.input || !path.isAbsolute(request.input.runDir)) throw new Error('Worker requires an absolute runDir');
      result = await resumeRun({ ...common, runDir: request.input.runDir, humanOutput: request.input.humanOutput, humanNodeRunId: request.input.humanNodeRunId, humanSubmission: request.input.humanSubmission, retryFailedNode: request.input.retryFailedNode });
    }
    await events.drain();
    await ai.drain();
    // Close child-owned resources before telling the parent that the workflow worker is finished.
    await close();
    await sendWorkerMessage({ type: 'done', runId: result.runId, status: result.status });
  } finally { await close(); }
}
