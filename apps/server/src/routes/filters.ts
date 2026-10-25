import type { FastifyInstance } from 'fastify';
import type { FilterPort } from '../ports';
import type { FilterConditions } from '@openhilo/platform-services/run-history';

export function registerFilterRoutes(app: FastifyInstance, svc: FilterPort): void {

  app.get('/api/filters', async () => svc.list());

  app.post('/api/filters', async (req, reply) => {
    const body = req.body as { name: string; conditions: FilterConditions };
    const filter = await svc.create(body);
    return reply.code(201).send(filter);
  });

  app.delete('/api/filters/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await svc.delete(id);
    if (!ok) return reply.code(404).send({ error: 'Filter not found' });
    return reply.code(204).send();
  });
}
