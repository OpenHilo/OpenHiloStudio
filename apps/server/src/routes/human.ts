import { isJsonValue } from '@openhilo/ai-contracts';
import type { HumanSubmission } from '@openhilo/human-contracts';
import { isAiQuestionKey, readAiQuestions } from '@openhilo/platform-services/ai-questions';
import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { listRuns, findRunDir } from '@openhilo/platform-services/run-history';
import { extractHumanNodeInfo, extractHumanHistory } from '@openhilo/platform-services/human-history';
import type { WorkerPort as WorkerManager } from '../ports';
import type { ServerPaths } from '../ports';

export function registerHumanRoutes(app: FastifyInstance, workerManager: WorkerManager, paths: ServerPaths): void {
  const runsDir = paths.runsDir;


  app.get('/api/runs/:id/ai-questions', async (req, reply) => {
    workerManager.refreshStops?.();
    const { id } = req.params as { id: string };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) as { status: string };
    const active = workerManager.isActive(id) && !workerManager.stopState?.(id) && run.status === 'running';
    return readAiQuestions(path.join(runDir, 'ai-questions.json')).map(question => ({ ...question,
      available: active && question.status === 'pending',
      ...(!active && question.status === 'pending' ? { status: 'closed', reason: 'Execution is unavailable' } : {}),
      ...(!active && question.status === 'answering' ? { status: 'outcome_unknown', reason: 'Answer delivery outcome is unknown' } : {}),
    }));
  });

  app.post('/api/runs/:id/ai-questions/answer', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { key?: unknown; value?: unknown } | null;
    if (!body || !isAiQuestionKey(body.key) || !isJsonValue(body.value)) return reply.code(400).send({ error: 'A question key and JSON answer are required' });
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });
    const key = body.key;
    const question = readAiQuestions(path.join(runDir, 'ai-questions.json')).find(q => q.taskId === key.taskId && q.attemptId === key.attemptId && q.questionId === key.questionId);
    if (!question) return reply.code(404).send({ error: 'Question not found' });
    // A committed receipt stays idempotent after the worker exits.
    if (question.status === 'answered') return { receipt: 'duplicate' };
    if (question.status === 'closed' || question.status === 'outcome_unknown') return reply.code(409).send({ receipt: question.status });
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) as { status: string };
    if (!workerManager.isActive(id) || run.status !== 'running') return reply.code(409).send({ receipt: question.status === 'answering' ? 'outcome_unknown' : 'unavailable' });
    const receipt = await workerManager.answerAiQuestion(id, body.key, body.value);
    return reply.code(receipt === 'accepted' || receipt === 'duplicate' ? 200 : receipt === 'invalid_answer' ? 400 : 409).send({ receipt });
  });

  app.get('/api/human-todos', async () => {
    workerManager.refreshStops?.();
    const { runs } = await listRuns({ runsDir, filters: { status: 'suspended' }, limit: Number.MAX_SAFE_INTEGER });
    const todos = [];
    for (const run of runs) {
      if (workerManager.stopState?.(run.run_id)) continue;
      const runDir = await findRunDir(run.run_id, runsDir);
      if (!runDir) continue;
      const info = await extractHumanNodeInfo(runDir, run.intent, true);
      if (info) todos.push({ runId: run.run_id, intent: run.intent, workdir: run.workdir, ...info });
    }
    return todos;
  });

  app.get('/api/runs/:id/human-node', async (req, reply) => {
    workerManager.refreshStops?.();
    const { id } = req.params as { id: string };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });
    if (workerManager.stopState?.(id)) return reply.code(409).send({ error: 'This run is stopping. No answer can be accepted; view the run status for cleanup progress.' });
    const runJson = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf-8')) as { status: string; intent: string };
    if (runJson.status !== 'suspended') return reply.code(400).send({ error: 'This run is no longer waiting for a human answer. View the run status for its latest progress.' });
    const info = await extractHumanNodeInfo(runDir, runJson.intent, true);
    if (!info) return reply.code(404).send({ error: 'No pending human node found' });
    return info;
  });

  app.get('/api/runs/:id/human-history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });
    const runJson = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf-8')) as { intent: string };
    return extractHumanHistory(runDir, runJson.intent);
  });

  app.post('/api/runs/:id/human-node', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { humanOutput?: Record<string, string>; humanNodeRunId?: string; humanSubmission?: HumanSubmission };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });
    const receipt = workerManager.forkResume(id, { runDir, humanOutput: body.humanOutput, humanNodeRunId: body.humanNodeRunId, humanSubmission: body.humanSubmission });
    if (receipt) return reply.code(receipt.status === 'invalid' ? 400 : receipt.status === 'conflict' || receipt.status === 'stale' ? 409 : 200).send(receipt);
    return { runId: id };
  });
}
