import type { FastifyInstance } from 'fastify';
import type { GenerationPort } from '../ports';
import type { SessionInput } from '@openhilo/platform-services/generation-session';
import { normalizeTranslateInput } from './translate-input';
export function registerTranslateRoutes(app: FastifyInstance, service: GenerationPort): void {
  app.post('/api/translate/:sid/stop', async (req, reply) => {
    if (!service.stop) return reply.code(501).send({ error: 'Stopping generation is not supported by this deployment' });
    return service.stop((req.params as { sid: string }).sid);
  });
  app.get('/api/translate', async (req, reply) => {
    if (!service.list) return reply.code(501).send({ error: 'Generation history is not supported by this deployment' });
    const query = req.query as { offset?: string; limit?: string; group?: string };
    const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 20);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ error: 'offset must be non-negative and limit must be between 1 and 100' });
    }
    if (query.group !== undefined && !['recent', 'attention', 'active', 'published', 'ended', 'error'].includes(query.group)) return reply.code(400).send({ error: 'Invalid generation group' });
    return service.list({ offset, limit, ...(query.group ? { group: query.group as 'recent' | 'attention' | 'active' | 'published' | 'ended' | 'error' } : {}) });
  });
  app.post('/api/translate/:sid/restore-history', async (req, reply) => {
    if (!service.restoreHistory) return reply.code(501).send({ error: 'History restore is not supported by this deployment' });
    await service.restoreHistory((req.params as { sid: string }).sid);
    return { restored: true };
  });
  app.delete('/api/translate/:sid', async (req, reply) => {
    if (!service.removeHistory) return reply.code(501).send({ error: 'History deletion is not supported by this deployment' });
    await service.removeHistory((req.params as { sid: string }).sid);
    return { deleted: true };
  });
  app.post('/api/translate/start', async (req, reply) => {
    const body = req.body as { naturalLanguage?: unknown; workspace?: unknown; requestId?: unknown } | null;
    if (!body || typeof body.naturalLanguage !== 'string' || !body.naturalLanguage.trim() ||
      (body.workspace !== undefined && typeof body.workspace !== 'string')) return reply.code(400).send({ error: 'naturalLanguage and optional workspace must be strings' });
    if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId)))
      return reply.code(400).send({ error: 'requestId must be a UUID' });
    return service.start({ naturalLanguage: body.naturalLanguage, workspace: body.workspace as string | undefined,
      ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}) });
  });
  app.post('/api/translate/:sid/respond', async req => {
    const { sid } = req.params as { sid: string };
    return service.respond(sid, normalizeTranslateInput(req.body) as SessionInput);
  });
  app.get('/api/translate/:sid', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const step = await service.read(sid);
    if (!step) return reply.code(404).send({ error: 'Session not found' });
    return step;
  });
}
