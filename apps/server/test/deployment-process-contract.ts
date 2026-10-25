import { startDeploymentProcess, type ProcessDeployment } from '@openhilo/server/deployment-process';
declare const create: () => Promise<ProcessDeployment>;
const started: Promise<{ address: string | undefined; close(): Promise<void> }> = startDeploymentProcess({
  host: '127.0.0.1', port: 0, create,
  onListening(address) { address.toUpperCase(); },
});
void started;
