const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTaskExecution } = require('@openhilo/ai-contracts');
const { GenerationSession } = require('@openhilo/platform-services/generation-session');
const { WorktreeCapacityError } = require('@openhilo/platform-services/worktree-pool');
const good = () => ({ ok: true, added: ['summary.ts'], modified: [], deleted: [], contents: {}, diffs: {} });
const complete = session => ({ status: 'completed', outputs: { entries: ['team/summary'] }, artifacts: [], ...(session ? { session } : {}) });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-service-'));
  const sessions = [];
  t.after(async () => { await Promise.all(sessions.map(s => s.flushPersistence())); await fs.rm(dir, { recursive: true, force: true }); });
  const calls = [];
  const services = {
    checkoutWorktree(id) { calls.push(['checkout', id]); return dir; },
    assertWorktreeOwner(_dir, id) { calls.push(['owner', id]); },
    returnWorktree(_dir, id) { calls.push(['archive', id]); return dir + '-archived'; },
    async runPreflight() { return good(); },
    async executeMerge() { calls.push(['publish']); },
  };
  const config = { workspace: dir, sessionDir: path.join(dir, 'session'), publicationDir: path.join(dir, 'published'), services, maxClarificationRounds: 3, maxFeedbackRounds: 3 };
  return { dir, config, services, calls, track(s) { sessions.push(s); return s; } };
}
function executor(run) { return { id: 'fixture', capabilities: ['structured_output', 'workspace', 'questions', 'continue'],
  async start(request, host) { return createTaskExecution(request, host, ctx => run(ctx, request, host)); } }; }

test('generic generation receives current runtime operation contracts on initial and repair attempts', async t => {
  const f = await fixture(t); const requests = [];
  let preflights = 0;
  f.services.runPreflight = async () => ++preflights === 1
    ? { ...good(), ok: false, compileErrors: 'Repair the source' } : good();
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: executor(async (_ctx, request) => {
    requests.push(request); return complete();
  }) }));
  assert.equal((await s.respond({ type: 'start', naturalLanguage: 'Track records when needed' })).phase, 'confirm_merge');
  assert.equal(requests.length, 2);
  const { platformSystemMethods } = require('@openhilo/platform-services/compiler-capabilities');
  for (const request of requests) {
    assert.ok(request.instruction.includes(JSON.stringify(platformSystemMethods)), 'AI receives the compiler operation catalogue, including createEntity argument order and named outputs');
  }
  const { buildGenericPrompt } = require('@openhilo/generation-contracts');
  const standalone = buildGenericPrompt({ naturalLanguage: 'Say hello', round: 1, maxRounds: 3 });
  assert.ok(!standalone.userMessage.includes('Available runtime system operations'), 'standalone prompt does not claim unprovided runtime capabilities');
  await s.close();
});

test('capacity failure preserves links to owning sessions across restoration without invoking AI', async t => {
  const f = await fixture(t); let starts = 0;
  f.services.checkoutWorktree = () => { throw new WorktreeCapacityError(['existing-review']); };
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: executor(async () => { starts++; return complete(); }) }));
  const step = await s.respond({ type: 'start', naturalLanguage: 'Keep my request' });
  assert.equal(step.phase, 'error');
  assert.deepEqual(step.blockingSessionIds, ['existing-review']);
  await s.close();
  const restored = GenerationSession.fromJSON(s.toJSON());
  assert.deepEqual(restored.currentStep().blockingSessionIds, ['existing-review']);
  assert.equal(restored.currentStep().naturalLanguage, 'Keep my request');
  assert.equal(starts, 0);
});

test('publication target drift stops without spending AI repair attempts or releasing other work', async t => {
  const f = await fixture(t); let starts = 0;
  f.services.runPreflight = async () => ({ ...good(), ok: false, requiresTargetSync: true,
    compileErrors: 'The publication target has advanced. Synchronize the candidate first.' });
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: executor(async () => { starts++; return complete(); }) }));
  const step = await s.respond({ type: 'start', naturalLanguage: 'Keep my candidate' });
  assert.equal(step.phase, 'error');
  assert.equal(step.retryable, false);
  assert.match(step.message, /Synchronize the candidate/);
  assert.equal(starts, 1, 'a Git ancestry conflict is not a compiler repair');
  await s.close();
  assert.equal(s.toJSON().archivedWorktreePath, f.dir + '-archived');
  assert.deepEqual(f.calls.filter(([call]) => call === 'archive'), [['archive', s.id]]);
  assert.equal(f.calls.some(([call]) => call === 'publish'), false);
});

test('standalone lifecycle questions, repairs, restores review and publishes through explicit ports', async t => {
  const f = await fixture(t); let attempts = 0, preflights = 0;
  const ref = { executorId: 'fixture', version: 1, opaqueId: 'conversation' };
  f.services.runPreflight = async () => ++preflights === 1 ? { ...good(), ok: false, compileErrors: 'Expected a string' } : good();
  const ai = executor(async (ctx, request) => {
    if (++attempts === 1) assert.equal(await ctx.ask({ id: 'q', prompt: 'Language?', answer: 'text' }), 'English');
    else { assert.deepEqual(request.continuation, ref); assert.match(request.instruction, /Expected a string/); }
    return complete(ref);
  });
  ai.releaseSession = async saved => { assert.deepEqual(saved, ref); f.calls.push(['release']); };
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: ai }));
  assert.equal((await s.respond({ type: 'start', naturalLanguage: 'Create summary' })).phase, 'cc_waiting_for_answer');
  assert.equal((await s.respond({ type: 'mcp_answer', questionId: 'q', answer: 'English' })).phase, 'confirm_merge');
  const saved = JSON.parse(JSON.stringify(s.toJSON()));
  for (const key of ['services', 'aiExecutor', 'aiHost', 'questionBridge', 'entityManager']) assert.equal(saved.config[key], undefined);
  const restored = f.track(GenerationSession.fromJSON(saved));
  await assert.rejects(restored.respond({ type: 'merge_approve', reviewId: restored.currentStep().reviewId }), /services must be rebound/);
  restored.bindServices(f.services); restored.bindAiExecutor(ai);
  assert.deepEqual(await restored.respond({ type: 'merge_approve', reviewId: restored.currentStep().reviewId }), { phase: 'done', savedPath: f.config.publicationDir, savedPaths: [path.join(f.config.publicationDir, 'team/summary')], entries: ['team/summary'], naturalLanguage: 'Create summary', answers: { 'Language?': 'English' }, answerHistory: [{ questionId: 'q', question: 'Language?', answer: 'English' }] });
  assert.deepEqual(f.calls.filter(([c]) => ['publish', 'release', 'archive'].includes(c)).map(([c]) => c), ['publish', 'release', 'archive']);
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.config.sessionDir, 'session.json'), 'utf8')).phase, 'done');
  await assert.rejects(restored.respond({ type: 'merge_approve', reviewId: 'old-page' }),
    error => error.statusCode === 409 && /no longer waiting for review/.test(error.message));
  assert.equal(f.calls.filter(([call]) => call === 'publish').length, 1);
});

test('no default paths or default AI provider are supplied by the package', async t => {
  const f = await fixture(t);
  assert.throws(() => GenerationSession.create({ ...f.config, sessionDir: undefined }), /explicit absolute path/);
  assert.throws(() => GenerationSession.load('../elsewhere', f.dir), /Invalid generation snapshot location/);
  const s = f.track(GenerationSession.create(f.config));
  assert.match((await s.respond({ type: 'start', naturalLanguage: 'Work' })).message, /must be rebound; no provider was substituted/);
  assert.equal(f.calls.some(([name]) => name === 'publish'), false);
});

test('publication failure preserves the candidate lease and is not automatically replayed', async t => {
  const f = await fixture(t); let publications = 0;
  f.services.executeMerge = async () => { publications++; throw new Error('Publication unavailable'); };
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: executor(async () => complete()) }));
  await s.respond({ type: 'start', naturalLanguage: 'Work' });
  await assert.rejects(s.respond({ type: 'merge_approve', reviewId: s.currentStep().reviewId }), /Publication unavailable/);
  assert.equal(s.currentStep().phase, 'confirm_merge');
  assert.equal(s.toJSON().worktreePath, f.dir);
  assert.equal(publications, 1); assert.equal(f.calls.some(([c]) => c === 'archive'), false);
  await s.respond({ type: 'merge_reject' });
});

test('changed publication receipt requires another review before publishing', async t => {
  const f = await fixture(t); let publications = 0;
  let revision = 0;
  f.services.runPreflight = async () => ({ ...good(), contents: { 'summary.ts': `revision ${++revision}` } });
  f.services.executeMerge = async () => { if (++publications === 1) throw new Error('current publication receipt changed; review again'); };
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: executor(async () => complete()) }));
  await s.respond({ type: 'start', naturalLanguage: 'Work' });
  const oldReview = s.currentStep().reviewId;
  await assert.rejects(s.respond({ type: 'merge_approve' }), error => error.statusCode === 409);
  assert.equal(publications, 0);
  assert.equal((await s.respond({ type: 'merge_approve', reviewId: oldReview })).phase, 'confirm_merge');
  assert.equal(publications, 1); assert.equal(f.calls.some(([c]) => c === 'archive'), false);
  assert.notEqual(s.currentStep().reviewId, oldReview);
  await assert.rejects(s.respond({ type: 'merge_approve', reviewId: oldReview }), error => error.statusCode === 409);
  assert.equal(publications, 1, 'a stale second tab cannot publish the replacement candidate');
  const restored = f.track(GenerationSession.fromJSON(s.toJSON()));
  assert.equal(restored.currentStep().reviewId, s.currentStep().reviewId, 'unchanged review identity survives serialization');
  assert.equal((await s.respond({ type: 'merge_approve', reviewId: s.currentStep().reviewId })).phase, 'done');
});

test('restored provider identity cannot be replaced by a differently configured executor', async t => {
  const f = await fixture(t);
  const s = f.track(GenerationSession.fromJSON({ id: 'saved', config: { ...f.config, aiExecutor: executor(async () => complete()) },
    phase: 'confirm_merge', round: 1, feedbackRoundsUsed: 0, naturalLanguage: 'Work', sessionDir: f.config.sessionDir,
    aiExecutorId: 'original', aiSession: { executorId: 'original', version: 1, opaqueId: 'saved' } }));
  await assert.rejects(s.respond({ type: 'merge_reject' }), /identity does not match/);
  assert.equal(f.calls.some(([c]) => c === 'archive'), false);
});

test('subpath loads without SQLite, domain application, native adapter or either SDK', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['-e', `
    const Module = require('node:module'); const load = Module._load;
    Module._load = function(id, ...args) {
      if (/better-sqlite3|@intentorch|ai-claude-code|ai-sdk|anthropic|openai/.test(id)) throw new Error('Forbidden dependency: ' + id);
      return load.call(this, id, ...args);
    };
    require('@openhilo/platform-services/generation-session');
  `], { stdio: 'pipe' });
});

test('unattached snapshots do not claim to resume work when no legacy adapter is installed', async t => {
  const f = await fixture(t);
  const s = f.track(GenerationSession.fromJSON({ id: 'saved', config: f.config,
    phase: 'cc_waiting_for_answer', round: 1, feedbackRoundsUsed: 0, naturalLanguage: 'Work', sessionDir: f.config.sessionDir,
    pendingMcpQuestion: { id: 'old', question: 'Proceed?' } }));
  const step = await s.respond({ type: 'mcp_answer', questionId: 'old', answer: 'yes' });
  assert.equal(step.phase, 'error'); assert.match(step.message, /not replayed/);
  assert.equal(f.calls.length, 0);
});

test('policy preparation uses an isolated scratch workspace that cannot change the brain', async t => {
  const f = await fixture(t); let workspace;
  const policy = { namespace: 'test.workspace-policy', version: 1,
    async prepare(_text, context) { workspace = context.workspace; await fs.writeFile(require('node:url').fileURLToPath(workspace.uri) + '/policy-write.txt', 'classification'); return {}; },
    restore: value => value, buildPrompt: () => ({ systemPrompt: 'tester', userMessage: 'work' }) };
  const s = f.track(GenerationSession.create({ ...f.config, generationPolicy: policy, aiExecutor: executor(async () => complete()) }));
  assert.equal((await s.respond({ type: 'start', naturalLanguage: 'work' })).phase, 'confirm_merge');
  assert.notEqual(workspace.id, f.config.workspace);
  assert.equal(path.dirname(workspace.id), f.config.sessionDir);
  assert.equal(workspace.uri, require('node:url').pathToFileURL(workspace.id).href);
  await assert.rejects(fs.stat(workspace.id), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.config.workspace, 'policy-write.txt')), { code: 'ENOENT' });
});


test('failed policy preparation cleans its isolated workspace without starting generation', async t => {
  const f = await fixture(t); let workspace;
  const policy = { namespace: 'test.failed-policy', version: 1,
    async prepare(_text, context) { workspace = context.workspace; await fs.writeFile(require('node:url').fileURLToPath(workspace.uri) + '/partial.txt', 'partial'); throw Error('classifier failed'); },
    restore: value => value, buildPrompt() { throw Error('must not generate'); } };
  const s = f.track(GenerationSession.create({ ...f.config, generationPolicy: policy }));
  assert.equal((await s.respond({ type: 'start', naturalLanguage: 'work' })).phase, 'error');
  await assert.rejects(fs.stat(workspace.id), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.config.workspace, 'partial.txt')), { code: 'ENOENT' });
  assert.equal(f.calls.length, 0);
});


test('generation exposes and persists AI stalls while its start request is still pending', async t => {
  const f = await fixture(t); let finish, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const s = f.track(GenerationSession.create({ ...f.config,
    aiHost: () => ({ monitoring: { heartbeatMs: 5, slowAfterMs: 5, stalledAfterMs: 10 } }),
    aiExecutor: executor(async () => { entered(); await new Promise(resolve => { finish = resolve; }); return complete(); }),
  }));
  const start = s.respond({ type: 'start', naturalLanguage: 'Work' });
  await ready;
  try {
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(s.currentStep().aiHealth?.condition, 'stalled');
    await s.flushPersistence();
    const saved = JSON.parse(await fs.readFile(path.join(f.config.sessionDir, 'session.json'), 'utf8'));
    assert.equal(saved.aiHealth.condition, 'stalled');
    assert.ok(saved.aiHealth.observedAt);
  } finally { finish(); await start; }
  assert.equal(s.currentStep().aiHealth, undefined);
});

test('generation never advertises or accepts replay of an unsafe retryable failure', async t => {
  const f = await fixture(t); let attempts = 0;
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: executor(async () => {
    attempts++; return { status: 'failed', error: { code: 'rate_limited', message: 'Failed after writing', retryable: true, safeToReplay: false } };
  }) }));
  const step = await s.respond({ type: 'start', naturalLanguage: 'Work' });
  assert.equal(step.retryable, false);
  await assert.rejects(s.respond({ type: 'retry' }), /not retryable|retry|invalid/i);
  assert.equal(attempts, 1);
});

test('accepted answer exposes running state while the next model response is still pending', async t => {
  const f = await fixture(t);
  let release, continued;
  const resumed = new Promise(resolve => { continued = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: executor(async ctx => {
    await ctx.ask({ id: 'progress-question', prompt: 'Proceed?', answer: 'text' });
    continued(); await hold;
    return complete();
  }) }));
  t.after(async () => { release(); await s.close(); });
  const waiting = await s.respond({ type: 'start', naturalLanguage: 'Work' });
  assert.equal(waiting.phase, 'cc_waiting_for_answer');
  assert.equal(waiting.aiHealth?.phase, 'waiting_for_input', 'question state must not wait for the next health heartbeat');
  const answering = s.respond({ type: 'mcp_answer', questionId: 'progress-question', answer: 'yes' });
  try {
    await resumed;
    await new Promise(resolve => setImmediate(resolve));
    const step = s.currentStep();
    assert.equal(step.phase, 'cc_running');
    assert.notEqual(step.aiHealth?.phase, 'waiting_for_input');
  } finally { release(); await answering; }
});

test('repeated question text preserves ordered answers across snapshots and later prompts', { timeout: 5000 }, async t => {
  const f = await fixture(t); let attempts = 0, preflights = 0;
  f.services.runPreflight = async () => ++preflights === 1 ? { ...good(), ok: false, compileErrors: 'Repair fixture' } : good();
  const ai = executor(async (ctx, request) => {
    if (++attempts === 1) {
      assert.equal(await ctx.ask({ id: 'first', prompt: 'Same question?', answer: 'text' }), 'ALPHA');
      assert.equal(await ctx.ask({ id: 'second', prompt: 'Same question?', answer: 'text' }), 'BETA');
    } else {
      assert.match(request.instruction, /ALPHA/);
      assert.match(request.instruction, /BETA/);
    }
    return complete();
  });
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: ai }));
  t.after(() => s.close());
  assert.equal((await s.respond({ type: 'start', naturalLanguage: 'Two answers' })).phase, 'cc_waiting_for_answer');
  assert.equal((await s.respond({ type: 'mcp_answer', questionId: 'first', answer: 'ALPHA' })).phase, 'cc_waiting_for_answer');
  const review = await s.respond({ type: 'mcp_answer', questionId: 'second', answer: 'BETA' });
  assert.equal(review.phase, 'confirm_merge', JSON.stringify(review));
  const history = [{ questionId: 'first', question: 'Same question?', answer: 'ALPHA' }, { questionId: 'second', question: 'Same question?', answer: 'BETA' }];
  assert.deepEqual(review.answerHistory, history);
  const restored = f.track(GenerationSession.fromJSON(JSON.parse(JSON.stringify(s.toJSON()))));
  assert.deepEqual(restored.currentStep().answerHistory, history);
  review.answerHistory[0].answer = 'changed client copy';
  assert.deepEqual(s.currentStep().answerHistory, history);
});

test('legacy answer maps restore into ordered history without fabricating missing turns', async t => {
  const f = await fixture(t);
  const s = f.track(GenerationSession.fromJSON({ id: 'old-answers', config: f.config,
    phase: 'done', round: 1, feedbackRoundsUsed: 0, naturalLanguage: 'Legacy', sessionDir: f.config.sessionDir,
    answers: { 'Language?': 'English', 'Format?': 'JSON' } }));
  assert.deepEqual(s.currentStep().answerHistory, [
    { question: 'Language?', answer: 'English' }, { question: 'Format?', answer: 'JSON' },
  ]);
});
