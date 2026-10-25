import * as nodePath from 'path';
import type { FastifyInstance } from 'fastify';
import type { EntityPort } from '../ports';
import type { WorkerPort as WorkerManager } from '../ports';
import { FailableError } from '@openhilo/runtime-contracts';
import { CasConflictError, EntityValidationError } from '@openhilo/platform-services/entity-store';
import { isJsonValue } from '@openhilo/ai-contracts';

function bodyObject(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) throw new EntityValidationError('Request body must be a JSON object without lossy values');
}
function validateCreationFields(desc: unknown, tags: unknown, data: unknown): void {
  if (desc !== undefined && typeof desc !== 'string') throw new EntityValidationError('desc must be a string');
  if (data !== undefined) bodyObject(data);
  if (tags !== undefined) {
    bodyObject(tags);
    if (Object.values(tags as Record<string, unknown>).some(value => typeof value !== 'string')) throw new EntityValidationError('Tag values must be strings');
  }
}

export function registerEntityRoutes(
  app: FastifyInstance,
  entityService: EntityPort,
  workerManager: WorkerManager,
): void {
  // ── Classes ───────────────────────────────────────────────────────────────

  app.get('/api/classes', async () => entityService.listClasses());

  app.get('/api/classes/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      return entityService.getClass(name);
    } catch (err) {
      if (err instanceof FailableError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/classes/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      const deleted = entityService.deleteClass(name);
      if (!deleted) return reply.code(404).send({ error: 'Class not found' });
      return { ok: true };
    } catch (err) {
      if (err instanceof FailableError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // ── Entities ──────────────────────────────────────────────────────────────

  app.get('/api/entities', async (req, reply) => {
    const { className } = req.query as { className?: string };
    if (!className) return reply.code(400).send({ error: 'className query parameter is required' });
    try {
      return entityService.listEntities(className);
    } catch (err) {
      if (err instanceof FailableError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return entityService.getEntity(id);
    } catch (err) {
      if (err instanceof FailableError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/classes', async (req, reply) => {
    bodyObject(req.body);
    const { name, schema, desc, tags } = req.body as { name: string; schema: unknown; desc: string; tags?: Record<string, string> };
    if (!name || typeof name !== 'string') return reply.code(400).send({ error: 'name is required' });
    validateCreationFields(desc, tags, schema);
    try {
      // EntityManager requires non-empty desc; use a single space when caller omits it
      entityService.defineClass(name, schema ?? {}, desc || ' ', tags ?? {});
      return reply.code(201).send({ ok: true });
    } catch (err) {
      if (err instanceof EntityValidationError) return reply.code(400).send({ error: err.message });
      if (err instanceof FailableError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/entities', async (req, reply) => {
    bodyObject(req.body);
    const { className, name, initData, desc, tags } = req.body as { className: string; name: string; initData: Record<string, unknown>; desc: string; tags?: Record<string, string> };
    if (!className || typeof className !== 'string') return reply.code(400).send({ error: 'className is required' });
    if (!name || typeof name !== 'string') return reply.code(400).send({ error: 'name is required' });
    validateCreationFields(desc, tags, initData);
    try {
      // EntityManager requires non-empty desc; use a single space when caller omits it
      const { id, created } = entityService.createEntity(className, name, initData ?? {}, desc || ' ', tags ?? {});
      return reply.code(created ? 201 : 200).send({ id });
    } catch (err) {
      if (err instanceof EntityValidationError) return reply.code(400).send({ error: err.message });
      if (err instanceof FailableError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.patch('/api/entities/:id', async (req, reply) => {
    bodyObject(req.body);
    const { id } = req.params as { id: string };
    const { fields, expectedVersion } = req.body as { fields: Record<string, unknown>; expectedVersion?: number };
    if (!fields || Array.isArray(fields) || typeof fields !== 'object') return reply.code(400).send({ error: 'fields is required' });
    try {
      entityService.updateEntity(id, fields, expectedVersion);
      return { ok: true };
    } catch (err) {
      if (err instanceof EntityValidationError) return reply.code(400).send({ error: err.message });
      if (err instanceof FailableError) {
        const status = err instanceof CasConflictError ? 409 : 404;
        return reply.code(status).send({ error: err instanceof CasConflictError ? 'This entity changed after you opened it. Your changes were not saved. Copy any edits you want to keep, cancel, refresh the page and reopen the entity to review the latest version.' : err.message, failedField: (err as any).failedField });
      }
      throw err;
    }
  });

  app.delete('/api/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const deleted = entityService.deleteEntity(id);
      if (!deleted) return reply.code(404).send({ error: 'Entity not found' });
      return { ok: true };
    } catch (err) {
      if (err instanceof FailableError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  // ── Tags ──────────────────────────────────────────────────────────────────

  app.get('/api/tag-definitions', async () => entityService.getTagDefinitions());

  app.patch('/api/entities/:id/tags', async (req, reply) => {
    bodyObject(req.body);
    const { id } = req.params as { id: string };
    const { tagName, tagValue } = req.body as { tagName: string; tagValue: string };
    if (typeof tagName !== 'string' || !tagName || typeof tagValue !== 'string' || !tagValue) return reply.code(400).send({ error: 'tagName and tagValue must be nonempty strings' });
    try {
      entityService.updateEntityTag(id, tagName, tagValue);
      return { ok: true };
    } catch (err) {
      if (err instanceof FailableError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // ── Intents ───────────────────────────────────────────────────────────────

  app.get('/api/intents', async () => workerManager.queryIntents());

  app.get('/api/intents/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      return await workerManager.queryIntentInfo(name);
    } catch (err) {
      if (err instanceof FailableError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/intents/by-tags', async (req, reply) => {
    const { conditions } = req.query as { conditions?: string };
    if (!conditions) return reply.code(400).send({ error: 'conditions query parameter is required (JSON array)' });
    try {
      const parsed = JSON.parse(conditions) as import('@openhilo/platform-services/entity-store').TagCondition[];
      return entityService.queryIntentsByTags(parsed);
    } catch (err) {
      if (err instanceof FailableError) return reply.code(400).send({ error: err.message });
      return reply.code(400).send({ error: 'conditions must be a valid JSON array of TagCondition objects' });
    }
  });

  // ── Schedulors ────────────────────────────────────────────────────────────

  app.get('/api/schedulors', async () => {
    const schedules = await workerManager.scheduleService.list();
    return schedules.map(s => {
      const base = nodePath.basename(s.ittPath);
      const intentName = base.endsWith('.itt.impl.json')
        ? base.slice(0, -'.itt.impl.json'.length)
        : base.endsWith('.itt.json')
          ? base.slice(0, -'.itt.json'.length)
          : base;
      return { id: s.id, intentName, cron: s.cron, params: s.inputs };
    });
  });

  app.get('/api/schedulors/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const schedules = await workerManager.scheduleService.list();
    const s = schedules.find(s => s.id === id);
    if (!s) return reply.code(404).send({ error: 'Scheduler not found' });
    const base = nodePath.basename(s.ittPath);
    const intentName = base.endsWith('.itt.impl.json')
      ? base.slice(0, -'.itt.impl.json'.length)
      : base.endsWith('.itt.json')
        ? base.slice(0, -'.itt.json'.length)
        : base;
    return { id: s.id, intentName, cron: s.cron, params: s.inputs };
  });

  app.delete('/api/schedulors/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await workerManager.scheduleService.delete(id);
    if (!deleted) return reply.code(404).send({ error: 'Scheduler not found' });
    return { ok: true };
  });
}
