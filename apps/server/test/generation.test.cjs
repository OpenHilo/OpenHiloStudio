const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const Module = require('node:module'), load = Module._load;
Module._load = function(name, ...args) {
  if (/ai-claude|ai-sdk|@intentorch|anthropic|^openai$|node-pty/.test(name)) throw new Error('Unexpected provider/domain dependency: ' + name);
  return load.call(this, name, ...args);
};
const Fastify = require('fastify');
const { registerTranslateRoutes } = require('@openhilo/server/routes/translate');
const { GenerationSession } = require('@openhilo/platform-services/generation-session');
const { createGenerationService } = require('@openhilo/platform-services/generation-service');
const { createFileSessionStorage } = require('@openhilo/platform-services/generation-storage');
const { createGenerationPipeline } = require('@openhilo/platform-services/generation-pipeline');
const { WorktreePool } = require('@openhilo/platform-services/worktree-pool');
const { git } = require('@openhilo/platform-services/publication');
const { createTaskExecution } = require('@openhilo/ai-contracts');
const { startRun } = require('@openhilo/runtime/run-service');
const { createDispatcher } = require('@openhilo/runtime/dispatcher');

test('independent HTTP generation clarifies, repairs real compiler feedback, survives review shutdown and publishes executable artifacts', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-http-pipeline-'));
  const brainDir = path.join(root, 'brain'), intentsDir = path.join(root, 'intents'), sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(brainDir); fs.mkdirSync(intentsDir);
  git(brainDir, ['init', '-b', 'main']); git(brainDir, ['config', 'user.email', 'fixture@local']); git(brainDir, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(brainDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['**/*.ts'] }));
  fs.writeFileSync(path.join(brainDir, 'keep.ts'), 'export const keep = 1;');
  git(brainDir, ['add', '.']); git(brainDir, ['commit', '-m', 'fixture']);
  const pool = new WorktreePool({ brainDir, poolDir: path.join(root, 'pool'), size: 1 });
  const pipeline = createGenerationPipeline({ brainDir, intentsDir });
  const services = { ...pipeline, checkoutWorktree: id => pool.checkout(id), assertWorktreeOwner: (dir, id) => pool.assertOwner(dir, id), returnWorktree: (dir, id) => pool.release(dir, id) };
  const storage = createFileSessionStorage(sessionsDir);
  let starts = 0, restores = 0;
  const source = '/** @entry */\nexport async function report(): Promise<{ value: number }> { return { value: 42 }; }';
  const executor = { id: 'offline.generation', capabilities: ['workspace', 'questions', 'structured_output'],
    async start(request, host) {
      const attempt = ++starts;
      return createTaskExecution(request, host, async ctx => {
        if (attempt === 1) assert.equal(await ctx.ask({ id: 'language', prompt: 'Language?', answer: 'text' }), 'English');
        else assert.match(request.instruction, /not assignable|compile failed/i);
        const worktree = fileURLToPath(host.workspace.uri); fs.mkdirSync(path.join(worktree, 'demo'), { recursive: true });
        fs.writeFileSync(path.join(worktree, 'demo', 'report.ts'), attempt === 1 ? source.replace('value: 42', 'value: "wrong"') : source);
        return { status: 'completed', outputs: { entries: ['demo/report'] }, artifacts: [] };
      });
    },
  };
  const options = { storage,
    create(input) {
      const id = randomUUID();
      return GenerationSession.create({ workspace: input.workspace ?? brainDir, sessionDir: path.join(sessionsDir, id), publicationDir: intentsDir,
        maxClarificationRounds: 2, maxFeedbackRounds: 3, services, aiExecutor: executor }, id);
    },
    inspect: saved => GenerationSession.fromJSON(saved),
    restore(saved) {
      restores++;
      assert.equal(saved.aiExecutorId, executor.id);
      const session = GenerationSession.fromJSON(saved); session.bindServices(services); session.bindAiExecutor(executor); return session;
    },
  };
  const apps = [];
  async function application() {
    const service = createGenerationService(options), app = Fastify(); apps.push(app);
    registerTranslateRoutes(app, service); app.addHook('preClose', async () => service.close()); await app.ready(); return app;
  }
  t.after(async () => { await Promise.all(apps.map(app => app.close())); fs.rmSync(root, { recursive: true, force: true }); });
  const first = await application();
  const created = await first.inject({ method: 'POST', url: '/api/translate/start', payload: { naturalLanguage: 'Create report' } });
  assert.equal(created.statusCode, 200, created.body);
  const { sessionId, step } = created.json(); assert.equal(step.phase, 'cc_running');
  let current;
  for (let attempt = 0; attempt < 100; attempt++) {
    current = (await first.inject(`/api/translate/${sessionId}`)).json();
    if (current.phase !== 'cc_running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(current.phase, 'cc_waiting_for_answer');
  assert.equal((await storage.load(sessionId)).sessionDir, path.join(sessionsDir, sessionId));
  const repaired = await first.inject({ method: 'POST', url: `/api/translate/${sessionId}/respond`, payload: { type: 'mcp_answer', questionId: 'language', answer: 'English' } });
  assert.equal(repaired.statusCode, 200, repaired.body); assert.equal(repaired.json().phase, 'confirm_merge'); assert.equal(starts, 2);
  assert.deepEqual(fs.readdirSync(intentsDir), []); assert.equal(fs.existsSync(path.join(brainDir, 'demo')), false);
  const reviewed = await storage.load(sessionId);
  assert.ok(reviewed.pendingPreflight.candidate); assert.equal(pool.snapshot()['ws-01'].sessionId, sessionId);
  await first.close();
  assert.equal((await storage.load(sessionId)).phase, 'confirm_merge');
  assert.equal(fs.existsSync(path.join(reviewed.worktreePath, 'demo', 'report.ts')), true);
  const second = await application();
  assert.equal((await second.inject(`/api/translate/${sessionId}`)).json().phase, 'confirm_merge'); assert.equal(restores, 0);
  const history = await second.inject('/api/translate?offset=0&limit=20');
  assert.equal(history.statusCode, 200); assert.equal(history.json().total, 1);
  assert.equal(history.json().sessions[0].sessionId, sessionId);
  assert.equal(history.json().sessions[0].naturalLanguage, 'Create report');
  assert.equal(history.json().sessions[0].phase, 'confirm_merge');
  assert.equal(restores, 0); assert.equal(starts, 2);
  assert.equal((await second.inject('/api/translate?limit=101')).statusCode, 400);
  assert.equal((await second.inject('/api/translate?offset=-1')).statusCode, 400);
  assert.equal((await second.inject({method:'DELETE',url:`/api/translate/${sessionId}`})).statusCode,409);
  const refreshed = await second.inject({ method: 'POST', url: `/api/translate/${sessionId}/respond`, payload: { type: 'merge_approve', reviewId: repaired.json().reviewId } });
  assert.equal(refreshed.statusCode, 200, refreshed.body); assert.equal(refreshed.json().phase, 'confirm_merge');
  assert.notEqual(refreshed.json().reviewId, repaired.json().reviewId);
  assert.equal(fs.existsSync(path.join(intentsDir, 'demo/report/report.itt.impl.json')), false);
  const approved = await second.inject({ method: 'POST', url: `/api/translate/${sessionId}/respond`, payload: { type: 'merge_approve', reviewId: refreshed.json().reviewId } });
  assert.equal(approved.statusCode, 200, approved.body); assert.equal(approved.json().phase, 'done'); assert.equal(restores, 1); assert.equal(starts, 2);
  assert.equal(pool.snapshot()['ws-01'].status, 'vacant');
  assert.equal(fs.readFileSync(path.join(brainDir, 'demo', 'report.ts'), 'utf8'), source);
  const entryFile = path.join(intentsDir, 'demo', 'report', 'report.itt.impl.json');
  const artifact = JSON.parse(fs.readFileSync(entryFile, 'utf8')); assert.equal(artifact.level, undefined);
  const run = await startRun({ intent: 'demo/report', entryFile, workdir: path.join(root, 'workspace'), runsDir: path.join(root, 'runs'), inputs: {},
    populateSnapshot: context => fs.copyFileSync(entryFile, path.join(context.snapshotDir, path.basename(entryFile))),
    createResources: context => ({ executor: createDispatcher({ workdir: context.workdir, runId: context.runId }) }),
  });
  assert.equal(run.status, 'completed');
  assert.equal((await second.inject(`/api/translate/${sessionId}`)).json().phase, 'done');
  assert.equal((await second.inject({method:'DELETE',url:`/api/translate/${sessionId}`})).statusCode,200);
  assert.equal((await second.inject('/api/translate?group=recent')).json().allTotal,0);
  assert.equal(fs.readFileSync(path.join(brainDir,'demo','report.ts'),'utf8'),source);
  assert.deepEqual(JSON.parse(fs.readFileSync(entryFile,'utf8')),artifact);
  assert.equal((await second.inject(`/api/translate/${sessionId}`)).json().phase,'done');
});

test('generation stop HTTP forwards the selected session and reports unsupported hosts', async t => {
  const stopped = [];
  const app = Fastify(); t.after(() => app.close());
  registerTranslateRoutes(app, {stop: async id => { stopped.push(id); return {phase: 'error', error: 'Generation stopped by user', retryable: false}; }});
  const response = await app.inject({method: 'POST', url: '/api/translate/selected/stop'});
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().retryable, false);
  assert.deepEqual(stopped, ['selected']);
  const unsupported = Fastify(); t.after(() => unsupported.close());
  registerTranslateRoutes(unsupported, {});
  assert.equal((await unsupported.inject({method: 'POST', url: '/api/translate/selected/stop'})).statusCode, 501);
});
