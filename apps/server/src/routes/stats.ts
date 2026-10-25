import type { FastifyInstance } from 'fastify';
import * as path from 'path';
import { getStats } from '@openhilo/platform-services/stats-service';
import type { WorkerPort as WorkerManager } from '../ports';
import type { ServerPaths } from '../ports';

export function registerStatsRoutes(app: FastifyInstance, workerManager: WorkerManager, paths: ServerPaths): void {
  const runsDir = paths.runsDir;
  app.get('/api/stats', async () => getStats(runsDir, workerManager.activeRunIds()));
}
