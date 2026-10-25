import {Rehydrator} from '@openhilo/runtime/rehydrator';
import type { RunInputEncoding } from '@openhilo/itt-contracts/run-inputs';
import { validateHumanSubmission } from './human-submission';
import type { HumanSubmission, HumanSubmissionReceipt } from '@openhilo/human-contracts';
import { currentHumanTask, readHumanSubmission, submitHumanTask } from '@openhilo/runtime/human-tasks';
import type { JsonValue } from '@openhilo/ai-contracts';
import type { AiQuestionKey, QuestionAnswerReceipt } from './ai-questions';
import { createWorkerQuestionClient } from './worker-questions';
/** Process supervision; AI, entity and schedule implementations are supplied by composition. */
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { WorkerMessage } from './worker-protocol';

interface SavedStop { runId: string; requestedAt: string; workerPid: number | null }
/** A sidecar avoids racing with the worker's run.json updates. */
function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export interface ForkRunOpts {
  ittPath: string;
  workdir: string;
  inputs: Record<string, string>;
  inputEncoding?: RunInputEncoding;
  suspend?: boolean;
  triggeredBy?: 'manual' | 'schedule';
}

export interface ForkResumeOpts {
  runDir: string;
  humanOutput?: Record<string, string>;
  humanNodeRunId?: string;
  humanSubmission?: HumanSubmission;
  retryFailedNode?: string;
}

export interface WorkerSupervisorOptions {
  /** Validate deployment compatibility before committing a human answer. */
  beforeResume?: (options: ForkResumeOpts) => void;
  /** Recover durable stop requests in this host's run store without replaying work. */
  runsDir?: string;
  launch(kind: 'run-worker' | 'resume-worker'): { file: string; options: child_process.ForkOptions };
  handleSystemCall(worker: child_process.ChildProcess, message: Extract<WorkerMessage, { type: 'sys_call' }>): Promise<void>;
  broadcaster: { publish(runId: string, data: string): void; closeAll(runId: string): void };
  /** Request cooperative child shutdown. Must only act on the supplied owned process.
   * Defaults to IPC disconnect; the supervisor still waits for actual process exit. */
  stopWorker?: (worker: child_process.ChildProcess) => void | Promise<void>;
  fork?: (file: string, args: string[], options: child_process.ForkOptions) => child_process.ChildProcess;
}

export class WorkerSupervisor {
  private readonly _workers = new Map<string, child_process.ChildProcess>();
  private readonly answers = new WeakMap<child_process.ChildProcess, ReturnType<typeof createWorkerQuestionClient>>();
  private readonly aborting = new Map<string, { requestedAt: string; error?: string }>();
  private readonly recoveredStops = new Map<string, { runJsonPath: string; workerPid: number | null }>();
  private readonly children = new Map<child_process.ChildProcess, { exited: Promise<void>; release(): void }>();
  private readonly systemCalls = new Set<Promise<void>>();
  private readonly workerCalls = new Map<child_process.ChildProcess, Set<Promise<void>>>();
  private closing: Promise<void> | undefined;
  private accepting = true;
  private readonly broadcaster: WorkerSupervisorOptions['broadcaster'];
  constructor(private readonly options: WorkerSupervisorOptions) {
    this.broadcaster = options.broadcaster;
    if (options.runsDir) this.recoverStops(options.runsDir);
  }

  private recoverStops(directory: string): void {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) this.recoverStops(file);
      else if (entry.name === 'stop-request.json') {
        const record = JSON.parse(fs.readFileSync(path.join(directory, 'run.json'), 'utf8'));
        this.restoreStop(record.run_id, path.join(directory, 'run.json'));
        this.reconcileStop(record.run_id);
      }
    }
  }

  private restoreStop(runId: string, runJsonPath: string): void {
    if (this.aborting.has(runId)) return;
    let saved: SavedStop;
    try { saved = JSON.parse(fs.readFileSync(path.join(path.dirname(runJsonPath), 'stop-request.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (saved.runId !== runId || !Number.isFinite(Date.parse(saved.requestedAt)) ||
        !(saved.workerPid === null || Number.isSafeInteger(saved.workerPid) && saved.workerPid > 0)) throw new Error('Invalid saved stop request');
    this.aborting.set(runId, { requestedAt: saved.requestedAt,
      error: 'A stop request survived a host restart. The previous worker exit is not confirmed; continuation is disabled. Updates continue automatically.' });
    this.recoveredStops.set(runId, { runJsonPath, workerPid: saved.workerPid });
  }

  private reconcileStop(runId: string): void {
    const saved = this.recoveredStops.get(runId);
    if (!saved) return;
    if (saved.workerPid !== null) {
      // Never signal or adopt a PID from disk: it may have been reused. Only
      // ESRCH proves absence; permission errors and reused PIDs stay uncertain.
      try { process.kill(saved.workerPid, 0); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    }
    this.finishAbort(runId, saved.runJsonPath);
  }

  /** Fork run-worker. Resolves with runId as soon as run directory is created. */
  forkRun(opts: ForkRunOpts): Promise<string> {
    if (!this.accepting) return Promise.reject(this.shutdownError());
    return new Promise((resolve, reject) => {
      const launch = this.options.launch('run-worker');
      const worker = (this.options.fork ?? child_process.fork)(launch.file, [], launch.options);
      this.track(worker);
      let runId: string | null = null;
      let runDir: string | null = null;
      let resolved = false;
      let terminalMessage = false;

      worker.on('message', (raw: WorkerMessage) => {
        if (terminalMessage) return;
        if (runId && this.aborting.has(runId)) return;
        if (raw.type === 'sys_call') { this.handleSystemCall(worker, raw); return; }
        if (raw.type === 'started') {
          runId = raw.runId;
          runDir = raw.runDir;
          this._workers.set(runId, worker);
          resolved = true;
          console.log(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] run started  runId=${runId} ittPath=${opts.ittPath}`);
          resolve(runId);
        } else if (raw.type === 'event') {
          if (runId) {
            this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'event', event: raw.event })}\n\n`);
          }
        } else if (raw.type === 'done') {
          terminalMessage = true;
          if (!runId) { reject(new Error('Worker completed before announcing its run')); return; }
          const id = runId;
          console.log(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] run done     runId=${id} status=${raw.status}`);
          this.broadcaster.publish(id, `data: ${JSON.stringify({ type: 'done', status: raw.status })}\n\n`);
          this.broadcaster.closeAll(id);
        } else if (raw.type === 'error') {
          terminalMessage = true;
          const msg = (raw as { message: string }).message;
          if (runId) {
            console.error(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] run error    runId=${runId} error=${msg}`);
            this._markRunFailed(runDir, msg);
            this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
            this.broadcaster.closeAll(runId);
          } else {
            console.error(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] run error (before start): ${msg}`);
            reject(new Error(msg));
          }
        }
      });

      worker.on('exit', (code, signal) => {
        const exitReason = signal ? `signal ${signal}` : `code ${code}`;
        if (runId && this.aborting.has(runId)) { this.finishAbort(runId, path.join(runDir!, 'run.json')); return; }
        if (terminalMessage) { if (runId) this._workers.delete(runId); return; }
        if (!resolved) {
          console.error(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] exited before start (${exitReason}) ittPath=${opts.ittPath}`);
          reject(new Error(`Worker exited unexpectedly (${exitReason})`));
        } else if (runId && this._workers.has(runId)) {
          // Worker exited without sending done/error — mark as failed
          const message = `Worker exited with ${exitReason}. In-flight effects have an unknown outcome; inspect the workdir before retrying.`;
          console.error(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] unexpected exit runId=${runId} ${exitReason}`);
          this._workers.delete(runId);
          this._markRunFailed(runDir, message);
          this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'error', message })}\n\n`);
          this.broadcaster.closeAll(runId);
        }
      });

      const onError = (err: Error) => {
        if (!worker.pid) this.children.get(worker)?.release();
        if (terminalMessage || (runId && this.aborting.has(runId))) return;
        terminalMessage = true;
        if (runId) {
          this._markRunFailed(runDir, err.message);
          this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
          this.broadcaster.closeAll(runId);
          if (!worker.pid) this._workers.delete(runId);
        }
        console.error(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] fork error: ${err.message}`);
        if (!resolved) { reject(err); if (worker.pid) worker.kill('SIGTERM'); }
      };
      worker.on('error', onError);
      try { worker.send(opts, error => { if (error) onError(error); }); }
      catch (error) { onError(error as Error); }
    });
  }

  private _markRunFailed(runDir: string | null, reason: string): void {
    if (!runDir) return;
    const runJsonPath = path.join(runDir, 'run.json');
    try {
      const runJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf-8'));
      if (['completed', 'aborted'].includes(runJson.status)) return;
      let changed = false;
      if (!['completed', 'aborted', 'failed'].includes(runJson.status)) {
        runJson.status = 'failed';
        changed = true;
      }
      if (!runJson.failReason) {
        runJson.failReason = reason;
        changed = true;
      }
      if (changed) {
        runJson.updated_at = new Date().toISOString();
        atomicJson(runJsonPath, runJson);
      }
    } catch { /* best effort */ }
  }

  forkResume(runId: string, opts: ForkResumeOpts): HumanSubmissionReceipt | void {
    this.restoreStop(runId, path.join(opts.runDir, 'run.json'));
    if (this.aborting.has(runId)) throw Object.assign(new Error('Run is stopping'), { statusCode: 409 });
    if (opts.humanSubmission !== undefined && opts.humanOutput !== undefined) {
      throw Object.assign(new Error('Provide either humanSubmission or humanOutput'), { statusCode: 400 });
    }
    if (!this.accepting) throw this.shutdownError();
    const receipt = JSON.parse(fs.readFileSync(path.join(opts.runDir, 'run.json'), 'utf8')) as { run_id: string; status: string };
    if (receipt.run_id !== runId) {
      throw Object.assign(new Error('Only the requested suspended run can be resumed'), { statusCode: 409 });
    }
    this.options.beforeResume?.(opts);
    let humanReceipt: HumanSubmissionReceipt | undefined;
    if (opts.retryFailedNode !== undefined) {
      if (this._workers.has(runId)) throw Object.assign(new Error('Run already has an active worker'), {statusCode:409});
      if (receipt.status !== 'failed' || typeof opts.retryFailedNode !== 'string' || !opts.retryFailedNode || opts.humanOutput !== undefined || opts.humanSubmission !== undefined) throw Object.assign(new Error('Failure resume requires the current failed step without human answers'), {statusCode:409});
      try {
        if (new Rehydrator(opts.runDir).rehydrate(undefined, false, opts.retryFailedNode).kind !== 'ok') throw new Error('No usable failed checkpoint');
      } catch (error) { throw Object.assign(error as Error, {statusCode:409}); }
    } else if (opts.humanSubmission !== undefined) {
      const taskId = opts.humanSubmission?.taskId;
      // A finishing suspended worker still owns the run. Do not accept a fresh
      // decision until it exits; committed decisions can always be retried.
      if (this._workers.has(runId) && !(typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(taskId) && readHumanSubmission(opts.runDir, taskId))) {
        throw Object.assign(new Error('Run already has an active worker'), { statusCode: 409 });
      }
      humanReceipt = submitHumanTask(opts.runDir, opts.humanSubmission);
      if (humanReceipt.status !== 'accepted' && humanReceipt.status !== 'duplicate') return humanReceipt;
      if (this._workers.has(runId) || currentHumanTask(opts.runDir)?.taskId !== humanReceipt.taskId) return humanReceipt;
    } else {
      if (this._workers.has(runId)) throw Object.assign(new Error('Run already has an active worker'), { statusCode: 409 });
      if (receipt.status !== 'suspended') throw Object.assign(new Error('Only the requested suspended run can be resumed'), { statusCode: 409 });
      if (!opts.humanOutput || typeof opts.humanOutput !== 'object' || Array.isArray(opts.humanOutput) ||
        Object.values(opts.humanOutput).some(value => typeof value !== 'string')) {
        throw Object.assign(new Error('humanOutput must be an object containing string values'), { statusCode: 400 });
      }
      validateHumanSubmission(opts.runDir, opts.humanOutput, opts.humanNodeRunId);
    }
    const launch = this.options.launch('resume-worker');
    const worker = (this.options.fork ?? child_process.fork)(launch.file, [], launch.options);
    this.track(worker);
    this._workers.set(runId, worker);
    let terminalMessage = false;

    console.log(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] resume started runId=${runId}`);
    worker.on('message', (raw: WorkerMessage) => {
      if (terminalMessage) return;
      if (this.aborting.has(runId)) return;
      if (raw.type === 'sys_call') { this.handleSystemCall(worker, raw); return; }
      if (raw.type === 'event') {
        this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'event', event: raw.event })}\n\n`);
      } else if (raw.type === 'done') {
        terminalMessage = true;
        console.log(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] resume done    runId=${runId} status=${raw.status}`);
        this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'done', status: raw.status })}\n\n`);
        this.broadcaster.closeAll(runId);
      } else if (raw.type === 'error') {
        terminalMessage = true;
        const msg = (raw as { message: string }).message;
        console.error(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] resume error  runId=${runId} error=${msg}`);
        this._markRunFailed(opts.runDir, msg);
        this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
        this.broadcaster.closeAll(runId);
      }
    });

    const onError = (err: Error) => {
      if (!worker.pid) this.children.get(worker)?.release();
      if (terminalMessage || this.aborting.has(runId)) return;
      terminalMessage = true;
      // A failed spawn has not advanced the checkpoint; retain it for a retry
      // of the already committed decision.
      if (worker.pid || !humanReceipt) this._markRunFailed(opts.runDir, err.message);
      this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      this.broadcaster.closeAll(runId);
      // An IPC error does not prove an existing process has exited.
      if (!worker.pid) this._workers.delete(runId);
    };
    worker.on('error', onError);

    worker.on('exit', (code, signal) => {
      if (this.aborting.has(runId)) { this.finishAbort(runId, path.join(opts.runDir, 'run.json')); return; }
      if (terminalMessage) { this._workers.delete(runId); return; }
      if (this._workers.has(runId)) {
        // Worker exited without sending done/error — mark as failed
        const exitReason = signal ? `signal ${signal}` : `code ${code}`;
        const message = `Resume worker exited with ${exitReason}. In-flight effects have an unknown outcome; inspect the workdir before retrying.`;
        console.error(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} [worker] resume unexpected exit runId=${runId} ${exitReason}`);
        this._workers.delete(runId);
        const runDir = opts.runDir;
        this._markRunFailed(runDir, message);
        this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'error', message })}\n\n`);
        this.broadcaster.closeAll(runId);
      }
    });

    try { worker.send(opts, error => { if (error) onError(error); }); }
    catch (error) { onError(error as Error); }
    return humanReceipt;
  }

  /** Acknowledges the request; only actual process exit establishes the terminal state. */
  abort(runId: string, runJsonPath: string): 'ok' | 'already_terminal' | 'not_found' {
    this.restoreStop(runId, runJsonPath);
    if (this.recoveredStops.has(runId)) { this.reconcileStop(runId); return 'ok'; }
    if (this.aborting.has(runId) && !this.aborting.get(runId)!.error) return 'ok';
    if (!fs.existsSync(runJsonPath)) return 'not_found';
    const runJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
    if (!this.aborting.has(runId) && ['completed', 'aborted', 'failed'].includes(runJson.status)) return 'already_terminal';
    const state = { requestedAt: this.aborting.get(runId)?.requestedAt ?? new Date().toISOString() };
    const worker = this._workers.get(runId);
    // No acknowledgement or shutdown side effect until this intent is saved.
    atomicJson(path.join(path.dirname(runJsonPath), 'stop-request.json'), { runId, requestedAt: state.requestedAt, workerPid: worker?.pid ?? null } satisfies SavedStop);
    this.aborting.set(runId, state);
    if (!worker) this.finishAbort(runId, runJsonPath);
    else void (async () => {
      // Deliver receipts for this worker's accepted effects before disconnecting.
      // New messages are denied by the aborting guard above.
      await Promise.all([...(this.workerCalls.get(worker) ?? [])]);
      if (!this.children.has(worker)) return;
      if (this.options.stopWorker) await this.options.stopWorker(worker);
      else if (worker.connected) worker.disconnect();
    })().catch(error => {
      if (this.aborting.get(runId) === state) {
        this.aborting.set(runId, { ...state, error: `Could not request worker shutdown: ${String(error)}` });
      }
    });
    return 'ok';
  }

  stopState(runId: string): { requestedAt: string; error?: string } | undefined {
    const state = this.aborting.get(runId);
    return state ? { ...state } : undefined;
  }

  /** Reconcile before reading run snapshots, so one response cannot combine
   * a pre-recovery terminal status with a post-recovery stop state. */
  refreshStops(): void {
    for (const runId of this.recoveredStops.keys()) this.reconcileStop(runId);
  }

  private finishAbort(runId: string, runJsonPath: string): void {
    this._workers.delete(runId);
    try {
      const runJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
      // Completion can win the race before the stop reaches the worker.
      if (!['completed', 'aborted'].includes(runJson.status)) {
        const event = { event: 'run_abort', ts: Date.now() / 1000, node_run_id: null, reason: 'Stopped by user; worker has exited.' };
        const log = path.join(path.dirname(runJsonPath), 'execution.jsonl');
        // A crash/full disk can occur between appending the event and saving
        // the status. Retrying finalization must not append it twice.
        const logged = fs.existsSync(log) && fs.readFileSync(log, 'utf8').split('\n').some(line => {
          try { return JSON.parse(line).event === 'run_abort'; } catch { return false; }
        });
        if (!logged) fs.appendFileSync(log, JSON.stringify(event) + '\n');
        runJson.status = 'aborted';
        runJson.updated_at = new Date().toISOString();
        delete runJson.failReason;
        atomicJson(runJsonPath, runJson);
        if (!logged) this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'event', event })}\n\n`);
      }
      fs.rmSync(path.join(path.dirname(runJsonPath), 'stop-request.json'), { force: true });
      this.recoveredStops.delete(runId);
      this.aborting.delete(runId);
      this.broadcaster.publish(runId, `data: ${JSON.stringify({ type: 'done', status: runJson.status })}\n\n`);
      this.broadcaster.closeAll(runId);
    } catch (error) {
      const state = this.aborting.get(runId)!;
      this.aborting.set(runId, { ...state, error: `Worker exited, but the final status could not be saved: ${String(error)}` });
    }
  }

  answerAiQuestion(runId: string, key: AiQuestionKey, value: JsonValue): Promise<QuestionAnswerReceipt> {
    const worker = this._workers.get(runId);
    if (!this.accepting || !worker || this.aborting.has(runId)) return Promise.resolve('unavailable');
    return this.answers.get(worker)!.answer(key, value);
  }

  private shutdownError(): Error {
    return Object.assign(new Error('Worker supervisor is shutting down'), { statusCode: 503 });
  }

  private track(worker: child_process.ChildProcess): void {
    this.answers.set(worker, createWorkerQuestionClient(worker));
    let release!: () => void;
    const exited = new Promise<void>(resolve => { release = resolve; });
    const finish = () => {
      this.answers.get(worker)?.close();
      this.children.delete(worker);
      release();
      worker.off('exit', finish);
      worker.off('error', failedSpawn);
    };
    const failedSpawn = () => { if (!worker.pid) finish(); };
    this.children.set(worker, { exited, release: finish });
    worker.once('exit', finish);
    worker.on('error', failedSpawn);
  }

  private handleSystemCall(worker: child_process.ChildProcess, message: Extract<WorkerMessage, { type: 'sys_call' }>): void {
    // Register synchronously before invoking the host, so close cannot miss accepted effects.
    const accepted = this.accepting;
    const operation = Promise.resolve().then(async () => {
      if (accepted) await this.options.handleSystemCall(worker, message);
      else await new Promise<void>((resolve, reject) => {
        try { worker.send({ type: 'sys_response', reqId: message.reqId, error: 'Worker supervisor is shutting down; call was not executed' }, error => error ? reject(error) : resolve()); }
        catch (error) { reject(error); }
      });
    }).catch(error => { console.error(`[worker] sys_call error: ${error instanceof Error ? error.message : String(error)}`); });
    this.systemCalls.add(operation);
    let calls = this.workerCalls.get(worker);
    if (!calls) { calls = new Set(); this.workerCalls.set(worker, calls); }
    calls.add(operation);
    void operation.then(() => {
      this.systemCalls.delete(operation);
      calls!.delete(operation);
      if (!calls!.size) this.workerCalls.delete(worker);
    });
  }

  /** Deny new runs, resumes, answers and system calls immediately. Existing effects still drain. */
  stopAccepting(): void { this.accepting = false; }

  /** Stop admission, deliver accepted system-call receipts, request shutdown, then await actual exits.
   * No deadline or implicit process-tree kill: a noncooperative child keeps this pending. The host
   * owns its stop policy through stopWorker and must not close shared stores before this settles. */
  close(): Promise<void> {
    this.stopAccepting();
    return this.closing ??= (async () => {
      while (this.systemCalls.size) await Promise.all([...this.systemCalls]);
      const children = [...this.children.entries()];
      const stopped = await Promise.allSettled(children.map(async ([worker]) => {
        if (!this.children.has(worker)) return;
        if (this.options.stopWorker) await this.options.stopWorker(worker);
        else if (worker.connected) worker.disconnect();
      }));
      const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Could not request worker shutdown; shared resources must remain open');
      await Promise.all(children.map(([, child]) => child.exited));
      while (this.systemCalls.size) await Promise.all([...this.systemCalls]);
    })();
  }

  isActive(runId: string): boolean {
    return this._workers.has(runId);
  }

  activeRunIds(): Set<string> {
    return new Set(this._workers.keys());
  }

}
