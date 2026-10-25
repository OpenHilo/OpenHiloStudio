import type { FastifyInstance } from 'fastify';
import { ConfigurationInputError } from '@openhilo/platform-services/configuration-service';
import type { ConfigurationPort } from '../ports';

export function registerConfigRoutes(app: FastifyInstance, service: ConfigurationPort): void {
  app.get('/api/config', async (_req, reply) => reply.send(await service.read()));
  app.put('/api/config', async (req, reply) => {
    try { return reply.send(await service.update(req.body)); }
    catch (error) {
      if (error instanceof ConfigurationInputError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
}
