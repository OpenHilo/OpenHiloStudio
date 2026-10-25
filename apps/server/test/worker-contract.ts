import { createWorkerLaunch } from '@openhilo/server/worker-launch';
import { runWorkflowWorker, type WorkflowWorkerFactory } from '@openhilo/server/workflow-worker';
import { createDispatcher } from '@openhilo/runtime/dispatcher';
import { createWorkerSystemClient } from '@openhilo/platform-services/worker-system-client';
import { createWorkerAiHost } from '@openhilo/platform-services/worker-ai-host';
const factory: WorkflowWorkerFactory = async request => ({
  runsDir: '/explicit/runs', intentsDir: '/explicit/intents',
  populateSnapshot(context) { void context; },
  createResources(context, ports) { return { executor: createDispatcher({ ...ports, workdir: context.workdir, runId: context.runId }) }; },
  async close() {},
});
void runWorkflowWorker;
void factory;
void createWorkerLaunch;
void createWorkerSystemClient;
void createWorkerAiHost;
