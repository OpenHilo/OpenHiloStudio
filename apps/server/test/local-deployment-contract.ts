import { createLocalDeployment, type LocalDeploymentOptions } from '@openhilo/server/local-deployment';
import { createWorkerLaunch } from '@openhilo/server/worker-launch';
import type { AiTaskExecutor } from '@openhilo/ai-contracts';
import { compileProgram } from '@openhilo/compiler';
declare const aiExecutor: AiTaskExecutor;
declare const clock: LocalDeploymentOptions['clock'];
const options: LocalDeploymentOptions = {
  home: '/explicit/home', aiExecutor, clock, allowedHosts: ['studio.example'], corsOrigin: ['https://studio.example'],
  launch: createWorkerLaunch({ compositionModule: '/explicit/worker.cjs' }),
  configuration: { read: () => ({}), update: input => input },
  generation: { compileProgram },
};
async function run() {
  const host = await createLocalDeployment(options);
  await host.app.listen({ port: 0, host: '127.0.0.1' });
  await host.startSchedules();
  await host.close();
}
void run;

import { initializeLocalHome } from '@openhilo/server/local-initialize';
import type { LocalCompositionFactory } from '@openhilo/server/local-cli';
const compose: LocalCompositionFactory = async () => options;
void compose; void initializeLocalHome;
