import { createDeploymentLifecycle } from '@openhilo/server/deployment-lifecycle';
import { WorkerSupervisor } from '@openhilo/platform-services/worker-supervisor';
import type { createGenerationService } from '@openhilo/platform-services/generation-service';
declare const workers: WorkerSupervisor;
declare const generation: ReturnType<typeof createGenerationService>;
const lifecycle = createDeploymentLifecycle({
  workers, generation,
  scheduler: { stop() {}, async drain() {} },
  store: { close() {} },
});
const drained: Promise<void> = lifecycle.quiesce();
const closed: Promise<void> = lifecycle.close();
void drained; void closed;
