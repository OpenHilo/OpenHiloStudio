import type { FastifyInstance } from 'fastify';
import type { SchedulerPort, SchedulePort } from '../ports';
import { ScheduleValidationError, type CreateScheduleInput, type Schedule } from '@openhilo/platform-services/schedule-service';

export function registerScheduleRoutes(app: FastifyInstance, scheduler: SchedulerPort, scheduleService: SchedulePort): void {
  const withTiming = (schedule: Schedule) => {
    const timing = scheduler.timing?.(schedule.id);
    return { ...schedule, ...(timing ? { nextRunAt: timing.nextRunAt, timeZone: timing.timeZone, ...(timing.lastAttempt ? { lastAttempt: timing.lastAttempt } : {}) } : {}),
      ...(!schedule.enabled ? { nextRunAt: undefined } : {}) };
  };
  app.get('/api/schedules', async () => (await scheduleService.list()).map(withTiming));
  // timing exposes the host clock's timezone even before any schedules exist.
  app.get('/api/schedules/meta', async () => ({ timeZone: scheduler.timing?.('')?.timeZone ?? null }));

  app.post('/api/schedules', async (req, reply) => {
    const body = req.body as CreateScheduleInput;
    let s;
    try { s = await scheduleService.create(body); }
    catch (error) { if (error instanceof ScheduleValidationError) return reply.code(400).send({ error: error.message }); throw error; }
    scheduler.register(s);
    return reply.code(201).send(withTiming(s));
  });

  app.patch('/api/schedules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const editable = ['name', 'cron', 'ittPath', 'workdir', 'inputs', 'enabled', 'flexible', 'inputEncoding'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !editable.includes(key))) {
      return reply.code(400).send({ error: 'Only schedule configuration fields can be edited' });
    }
    let updated;
    try { updated = await scheduleService.patch(id, body); }
    catch (error) { if (error instanceof ScheduleValidationError) return reply.code(400).send({ error: error.message }); throw error; }
    if (!updated) return reply.code(404).send({ error: 'Schedule not found' });
    scheduler.update(updated);
    return withTiming(updated);
  });

  app.delete('/api/schedules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await scheduleService.delete(id);
    if (ok) scheduler.unregister(id);
    if (!ok) return reply.code(404).send({ error: 'Schedule not found' });
    return reply.code(204).send();
  });
}
