import * as fs from 'fs';
import * as path from 'path';
import type { WorkerSupervisorOptions } from '@openhilo/platform-services/worker-supervisor';

/** Launch the packaged JavaScript worker with a trusted, explicit CJS composition module. */
export function createWorkerLaunch(options: { compositionModule: string; env?: NodeJS.ProcessEnv; cwd?: string }): WorkerSupervisorOptions['launch'] {
  if (!path.isAbsolute(options.compositionModule) || !fs.statSync(options.compositionModule).isFile()) throw new Error('Worker compositionModule must be an existing absolute file');
  if (options.cwd !== undefined && !path.isAbsolute(options.cwd)) throw new Error('Worker cwd must be absolute');
  const file = path.join(__dirname, 'worker-entry.js');
  if (!fs.existsSync(file)) throw new Error('Build @openhilo/server before launching workers');
  return kind => ({ file, options: {
    execArgv: [], cwd: options.cwd ?? path.dirname(options.compositionModule),
    env: { ...process.env, ...options.env, INTENTORCH_WORKER_COMPOSITION: options.compositionModule, INTENTORCH_WORKER_KIND: kind },
  } });
}
