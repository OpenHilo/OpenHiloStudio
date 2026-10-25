import * as path from 'path';
import { runWorkflowWorker, type WorkflowWorkerFactory, type WorkflowWorkerRequest } from './workflow-worker';
import { sendWorkerMessage } from '@openhilo/platform-services/worker-protocol';

process.once('message', async input => {
  try {
    const file = process.env.INTENTORCH_WORKER_COMPOSITION;
    const kind = process.env.INTENTORCH_WORKER_KIND;
    if (!file || !path.isAbsolute(file) || !['run-worker', 'resume-worker'].includes(kind ?? '')) throw new Error('Worker requires an explicit composition module and kind');
    const module = require(file) as { createComposition: WorkflowWorkerFactory };
    if (typeof module.createComposition !== 'function') throw new Error('Worker composition must export createComposition(request)');
    await runWorkflowWorker({ kind, input } as WorkflowWorkerRequest, module.createComposition);
    process.exit(0);
  } catch (error) {
    try { await sendWorkerMessage({ type: 'error', message: String(error) }); }
    finally { process.exit(1); }
  }
});
