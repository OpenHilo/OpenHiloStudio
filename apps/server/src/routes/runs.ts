import {qualifiedWorkflowName} from '@openhilo/platform-services/worker-run-path';
import {Rehydrator} from '@openhilo/runtime/rehydrator';
import { validateRunInputWire, type RunInputEncoding } from '@openhilo/itt-contracts/run-inputs';
import type { HumanSubmission } from '@openhilo/human-contracts';
import { containedFile, workflowSourceFile } from '../files';
import type { FastifyInstance } from 'fastify';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { listRuns, findRunDir } from '@openhilo/platform-services/run-history';
import type { WorkerPort as WorkerManager } from '../ports';
import type { FilterConditions } from '@openhilo/platform-services/run-history';
import type { ServerPaths } from '../ports';

/** Recursively resolve file_ref objects to their actual file contents. */
export function resolveFileRefs(value: unknown, runDir: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => resolveFileRefs(v, runDir));
  const obj = value as Record<string, unknown>;
  if (obj.type === 'file_ref' && typeof obj.path === 'string') {
    const candidate = path.resolve(runDir, obj.path);
    if (candidate.startsWith(path.resolve(runDir) + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return { type: 'file_ref_error', path: obj.path, error: 'EISDIR: path resolves to a directory, not a file' };
    const absPath = containedFile(runDir, obj.path);
    if (!absPath) return null;
    const content = fs.readFileSync(absPath, 'utf-8');
    return obj.path.endsWith('.json') ? JSON.parse(content) : content;
  }
  return Object.fromEntries(Object.entries(obj).map(([key, entry]) => [key, resolveFileRefs(entry, runDir)]));
}

export function registerRunRoutes(app: FastifyInstance, workerManager: WorkerManager, paths: ServerPaths): void {
  const runsDir = paths.runsDir;

  app.get('/api/runs', async (req, reply) => {
    workerManager.refreshStops?.();
    const q = req.query as Record<string, string>;
    const filters: FilterConditions = {};
    if (q.intent) filters.intent = q.intent;
    if (q.status) filters.status = q.status as FilterConditions['status'];
    if (q.workdir) filters.workdir = q.workdir;
    if (q.completedOn) filters.completedOn = q.completedOn;
    if (q.createdAfter) filters.createdAfter = q.createdAfter;
    if (q.createdBefore) filters.createdBefore = q.createdBefore;

    const page = Number(q.page ?? '1');
    const limit = Number(q.limit ?? '20');
    const result = await listRuns({ runsDir, filters, page, limit });

    const runs = result.runs.map(r => ({
      ...r,
      workflowName: r.ittPath ? qualifiedWorkflowName(r.ittPath, paths.intentsDir) : r.intent,
      stopping: workerManager.stopState?.(r.run_id),
      orphaned: r.status === 'running' && !workerManager.isActive(r.run_id),
    }));
    return { ...result, runs };
  });

  app.get('/api/runs/:id', async (req, reply) => {
    workerManager.refreshStops?.();
    const { id } = req.params as { id: string };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });

    const runJson = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf-8'));
    runJson.workflowName = runJson.ittPath ? qualifiedWorkflowName(runJson.ittPath, paths.intentsDir) : runJson.intent;
    runJson.stopping = workerManager.stopState?.(id);
    runJson.workerActive = workerManager.isActive(id);
    runJson.orphaned = runJson.status === 'running' && !workerManager.isActive(id);

    const tailParam = (req.query as Record<string, string>).tailEvents;
    const tail = tailParam === undefined ? 200 : Number(tailParam);
    if (!Number.isSafeInteger(tail) || tail < 0 || tailParam === '') return reply.code(400).send({ error: 'tailEvents must be a non-negative integer; use 0 for the full trace' });
    const jsonlPath = path.join(runDir, 'execution.jsonl');
    const events: unknown[] = [];
    if (fs.existsSync(jsonlPath)) {
      const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim());
      const slice = lines.slice(-tail);
      for (const l of slice) { try { events.push(JSON.parse(l)); } catch {} }
    }

    if (runJson.status === 'failed' && !runJson.stopping && !workerManager.isActive(id)) {
      try {
        const all = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const boundary = [...all].reverse().find(event => ['run_failed','run_resume','node_suspended','run_start'].includes(event.event));
        if (boundary?.event === 'run_failed' && new Rehydrator(runDir).rehydrate(undefined, false, boundary.node_run_id).kind === 'ok') {
          runJson.resumeFailure = { nodeRunId: boundary.node_run_id, reason: boundary.reason };
        }
      } catch { /* No usable final checkpoint: never offer a restart disguised as resume. */ }
    }
    return { ...runJson, events };
  });

  app.get('/api/runs/:id/snapshot', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });

    const runJson = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf-8')) as { intent?: string; entry_intent?: string };
    let intent = runJson.entry_intent ?? runJson.intent;
    if (!intent) return reply.code(404).send({ error: 'Run has no intent field' });

    const frameId = (req.query as { frameId?: unknown }).frameId;
    if (frameId !== undefined) {
      if (typeof frameId !== 'string' || !frameId) return reply.code(400).send({ error: 'frameId must be a non-empty string' });
      const logPath = path.join(runDir, 'execution.jsonl');
      const events = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').flatMap(line => {try {return [JSON.parse(line)];} catch {return [];}}) : [];
      const rootFrame = events.find(event => event?.event === 'node_pending')?.frame_id;
      if (frameId !== rootFrame) {
        const child = events.find(event => event?.event === 'frame_push' && event.frame_id === frameId);
        if (!child || typeof child.callee !== 'string') return reply.code(404).send({ error: 'Workflow call not found in this run' });
        intent = child.callee;
      }
    }

    const snapshotPath = containedFile(path.join(runDir, '.snapshot'), `${intent}.itt.impl.json`) ?? containedFile(path.join(runDir, '.snapshot'), `${intent}.itt.json`);
    if (!snapshotPath) return reply.code(404).send({ error: 'Snapshot not found' });

    return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
  });

  app.get('/api/runs/:id/ts-source', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });

    const runJson = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf-8')) as { intent?: string; entry_intent?: string; ittPath?: string };
    const intent = runJson.entry_intent ?? runJson.intent;
    const ittPath = runJson.ittPath;
    if (!intent || !ittPath) return reply.code(404).send({ error: 'Run has no intent/ittPath' });

    const rel = path.relative(paths.intentsDir, path.resolve(paths.intentsDir, ittPath));
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return reply.code(404).send({ error: 'Intent is outside the configured directory' });
    const namespace = path.dirname(path.dirname(rel)).split(path.sep).filter(part => part !== '.').join('.');
    const name = path.basename(rel).replace(/\.itt(?:\.impl)?\.json$/, '');
    const snapshot = containedFile(path.join(runDir, '.snapshot'), `${intent}.itt.impl.json`) ?? containedFile(path.join(runDir, '.snapshot'), `${intent}.itt.json`);
    const artifact = snapshot ?? containedFile(paths.intentsDir, rel);
    let metadata: unknown;
    try { metadata = artifact ? JSON.parse(fs.readFileSync(artifact, 'utf8')) : undefined; } catch { /* Legacy fallback still confines the source path. */ }
    const sourceHash = (metadata as { sourceTs?: unknown } | undefined)?.sourceTs;
    if (typeof sourceHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(sourceHash)) {
      const savedSource = containedFile(path.join(runDir, '.snapshot'), `.sources/${sourceHash.slice(7)}.ts`);
      if (savedSource) {
        const contents = fs.readFileSync(savedSource, 'utf8');
        if ('sha256:' + crypto.createHash('sha256').update(contents).digest('hex') === sourceHash) return { ts: contents };
      }
    }
    const tsPath = workflowSourceFile(paths.brainDir, namespace, name, metadata);
    if (!tsPath) return reply.code(404).send({ error: 'The exact source for this run is unavailable. It was not saved with the run, or the saved copy could not be verified. The current source may have changed; the execution snapshot and results remain available.' });

    return { ts: fs.readFileSync(tsPath, 'utf-8') };
  });

  app.get('/api/runs/:id/node/:nodeRunId/io', async (req, reply) => {
    const { id, nodeRunId } = req.params as { id: string; nodeRunId: string };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });

    const jsonlPath = path.join(runDir, 'execution.jsonl');
    const lines = fs.existsSync(jsonlPath)
      ? fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim())
      : [];

    // Inputs: prefer io_records file, fall back to node_pending event
    const inputsPath = containedFile(runDir, path.join('io_records', `${nodeRunId}_inputs.json`));
    let inputs: unknown = inputsPath
      ? JSON.parse(fs.readFileSync(inputsPath, 'utf-8'))
      : null;
    if (inputs === null) {
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as { event?: string; node_run_id?: string; inputs?: unknown };
          if (ev.event === 'node_pending' && ev.node_run_id === nodeRunId) {
            inputs = ev.inputs ?? null;
            break;
          }
        } catch { /* skip malformed lines */ }
      }
    }

    // Outputs: from node_success event
    let outputs: unknown = null;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as { event?: string; node_run_id?: string; outputs?: unknown };
        if (ev.event === 'node_success' && ev.node_run_id === nodeRunId) {
          outputs = ev.outputs ?? null;
          break;
        }
      } catch { /* skip */ }
    }

    const failure = lines.map(line => {try {return JSON.parse(line);} catch {return null;}})
      .reverse().find(event => event?.event === 'node_failed' && event.node_run_id === nodeRunId);
    return {
      ...(failure ? {error: failure.error, diagnostics: failure.diagnostics} : {}),
      inputs:  resolveFileRefs(inputs, runDir),
      outputs: resolveFileRefs(outputs, runDir),
    };
  });

  app.get('/api/runs/suggest-workdir', async (req, reply) => {
    const { intent } = req.query as { intent?: string };
    const name = (intent ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const uid = crypto.randomUUID().slice(0, 8);
    return { workdir: path.join(paths.workspacesDir, name, uid) };
  });

  app.post('/api/runs', async (req, reply) => {
    const body = req.body as { ittPath: string; workdir: string; inputs?: Record<string, string>; inputEncoding?: RunInputEncoding; suspend?: boolean; triggeredBy?: 'manual' | 'schedule' };
    if (!body || !body.ittPath || typeof body.ittPath !== 'string') {
      return reply.code(400).send({ error: 'ittPath is required' });
    }
    if (!body.workdir || typeof body.workdir !== 'string') {
      return reply.code(400).send({ error: 'workdir is required' });
    }
    if (!path.isAbsolute(body.workdir)) {
      return reply.code(400).send({ error: 'Choose an absolute working directory, or use Random to create one.' });
    }
    const relativeIntent = path.normalize(body.ittPath);
    if (!path.isAbsolute(body.ittPath) && (relativeIntent === '..' || relativeIntent.startsWith(`..${path.sep}`))) {
      return reply.code(400).send({ error: 'Relative workflow paths must stay within the intent library.' });
    }
    const inputs = body.inputs === undefined ? {} : body.inputs;
    try { validateRunInputWire(inputs, body.inputEncoding); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const runId = await workerManager.forkRun({
      ittPath: body.ittPath,
      workdir: body.workdir,
      inputs,
      ...(body.inputEncoding ? { inputEncoding: body.inputEncoding } : {}),
      suspend: body.suspend,
      triggeredBy: body.triggeredBy ?? 'manual',
    });
    return reply.code(201).send({ runId });
  });

  app.post('/api/runs/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { retryFailedNode?: string; humanOutput?: Record<string, string>; humanNodeRunId?: string; humanSubmission?: HumanSubmission };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });

    if (body.retryFailedNode !== undefined) {
      workerManager.forkResume(id, {runDir, retryFailedNode: body.retryFailedNode, humanOutput: body.humanOutput, humanSubmission: body.humanSubmission});
      return {runId: id};
    }
    if (body.humanSubmission !== undefined) {
      const receipt = workerManager.forkResume(id, { runDir, humanSubmission: body.humanSubmission, humanOutput: body.humanOutput, humanNodeRunId: body.humanNodeRunId });
      if (!receipt) throw new Error('Human submission did not return a receipt');
      return reply.code(receipt.status === 'invalid' ? 400 : receipt.status === 'conflict' || receipt.status === 'stale' ? 409 : 200).send(receipt);
    }
    const runJson = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf-8')) as { status: string };
    const terminalStatuses = ['completed', 'aborted'];
    if (terminalStatuses.includes(runJson.status)) {
      return reply.code(409).send({ error: `Run is in terminal state '${runJson.status}' and cannot be resumed` });
    }
    if (runJson.status !== 'suspended') {
      return reply.code(409).send({ error: `Run has status '${runJson.status}' and cannot be resumed` });
    }
    if (!body.humanOutput) {
      return reply.code(400).send({ error: 'Run is suspended at a human node — provide humanOutput' });
    }

    workerManager.forkResume(id, { runDir, humanOutput: body.humanOutput, humanNodeRunId: body.humanNodeRunId });
    return { runId: id };
  });

  app.post('/api/runs/:id/abort', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });
    const runJsonPath = path.join(runDir, 'run.json');
    const result = workerManager.abort(id, runJsonPath);
    if (result === 'not_found') return reply.code(404).send({ error: 'Run not found' });
    if (result === 'already_terminal') return reply.code(409).send({ error: 'Run is already in a terminal state' });
    return { ok: true };
  });
}
