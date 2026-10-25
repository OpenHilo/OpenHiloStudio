import type { FastifyInstance } from 'fastify';
import { GENERIC_STUDIO_APPLICATION, parseStudioApplication, type StudioApplication } from '@openhilo/studio-contracts';

/** Composition supplies a descriptor; this route never imports an application. */
export function registerApplicationRoutes(app: FastifyInstance, application: StudioApplication = GENERIC_STUDIO_APPLICATION): void {
  const descriptor = parseStudioApplication(application);
  app.get('/api/application', async () => descriptor);
}
