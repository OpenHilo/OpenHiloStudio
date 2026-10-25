const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTaskExecution } = require('@openhilo/ai-contracts');
const { GenerationSession } = require('@openhilo/platform-services/generation-session');
const complete = () => ({ status: 'completed', outputs: { entries: ['team/task'] }, artifacts: [] });
const good = () => ({ ok: true, added: [], modified: [], deleted: [], contents: {}, diffs: {} });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-replay-'));
  const sessions = [];
  t.after(async () => { await Promise.all(sessions.map(s => s.flushPersistence())); await fs.rm(dir, { recursive: true, force: true }); });
  const services = { checkoutWorktree() { return dir; }, assertWorktreeOwner() {}, returnWorktree() { return dir; }, async runPreflight() { return good(); } };
  const config = { workspace: dir, sessionDir: path.join(dir, 'session'), publicationDir: path.join(dir, 'published'), services, maxClarificationRounds: 3 };
  return { dir, config, services, track(s) { sessions.push(s); return s; } };
}
function executor(run) { return { id: 'fixture', capabilities: ['workspace', 'questions', 'structured_output'], async start(request, host) { return createTaskExecution(request, host, ctx => run(ctx)); } }; }
async function assertNoRetry(session, step) {
  assert.equal(step.phase, 'error');
  assert.equal(step.retryable, false, JSON.stringify(step));
  await assert.rejects(session.respond({ type: 'retry' }), /not retryable|invalid/i);
}

for (const state of ['failed', 'cancelled', 'completed']) {
  test(`closed answer receipt cannot create accepted history even when executor is ${state}`, async t => {
    const f = await fixture(t);
    const s = f.track(GenerationSession.create(f.config));
    s.injectQuestion('expired', 'Name?');
    s._aiExecution = { state, async answer() { return 'closed'; } };
    await assert.rejects(s.respond({ type: 'mcp_answer', questionId: 'expired', answer: 'not accepted' }), error => error.statusCode === 409);
    assert.equal((s.toJSON().answerHistory ?? []).length, 0);
    assert.equal(s.currentStep().questionId, 'expired');
  });
}

test('accepted result rejection cannot replay generation effects', async t => {
  const f = await fixture(t); let attempts = 0;
  const ai = { id: 'fixture', capabilities: ['workspace', 'questions', 'structured_output'], async start() {
    attempts++;
    await fs.appendFile(path.join(f.dir, 'effects'), 'effect\n');
    return { state: 'failed', result: Promise.reject(Error('Lost outcome')), async cancel() {}, async answer() { return 'closed'; } };
  } };
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: ai }));
  await assertNoRetry(s, await s.respond({ type: 'start', naturalLanguage: 'work' }));
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(path.join(f.dir, 'effects'), 'utf8'), 'effect\n');
});

for (const failure of ['invalid completed output', 'preflight exception']) {
  test(`${failure} after accepted work cannot start another attempt`, async t => {
    const f = await fixture(t); let attempts = 0;
    if (failure === 'preflight exception') f.services.runPreflight = async () => { throw Error('Preflight unreadable'); };
    const ai = { id: 'fixture', capabilities: ['workspace', 'questions', 'structured_output'], async start() {
      attempts++;
      return { state: 'completed', result: Promise.resolve(failure === 'invalid completed output' ? { status: 'completed', outputs: {}, artifacts: [] } : complete()), async cancel() {}, async answer() { return 'closed'; } };
    } };
    const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: ai }));
    await assertNoRetry(s, await s.respond({ type: 'start', naturalLanguage: 'work' }));
    assert.equal(attempts, 1);
  });
}

for (const phase of ['auto_fixing', 'cc_waiting_for_answer']) {
  test(`restored ${phase} with unknown effects cannot offer retry`, async t => {
    const f = await fixture(t);
    const s = f.track(GenerationSession.fromJSON({ id: 'saved', config: f.config, phase,
      round: 1, feedbackRoundsUsed: 0, naturalLanguage: 'work', sessionDir: f.config.sessionDir,
      aiExecutorId: 'fixture',
    }));
    await assertNoRetry(s, s.currentStep());
  });
}

test('unrecoverable saved question cannot be converted into a fresh attempt', async t => {
  const f = await fixture(t); let attempts = 0, returned = 0;
  f.services.returnWorktree = () => { returned++; return f.dir; };
  const ai = executor(async () => { attempts++; return complete(); });
  const s = f.track(GenerationSession.fromJSON({ id: 'saved', config: { ...f.config, aiExecutor: ai }, phase: 'cc_waiting_for_answer',
    round: 1, feedbackRoundsUsed: 0, naturalLanguage: 'work', sessionDir: f.config.sessionDir,
    worktreePath: f.dir, aiExecutorId: 'fixture', aiSession: { executorId: 'fixture', version: 1, opaqueId: 'old' }, pendingMcpQuestion: { id: 'q', question: 'Proceed?' },
  }));
  await assertNoRetry(s, await s.respond({ type: 'mcp_answer', questionId: 'q', answer: 'yes' }));
  assert.equal(attempts, 0);
  assert.equal(returned, 0, 'unknown live work must retain its lease');
  assert.equal(s.toJSON().worktreePath, f.dir);
  assert.equal(s.toJSON().aiSession.opaqueId, 'old');
});

test('preexecution resource failure remains explicitly retryable', async t => {
  const f = await fixture(t); let starts = 0;
  const ai = executor(async () => complete()); const start = ai.start;
  ai.start = async (...args) => { if (++starts === 1) throw Error('Resource unavailable before acceptance'); return start(...args); };
  const s = f.track(GenerationSession.create({ ...f.config, aiExecutor: ai }));
  assert.equal((await s.respond({ type: 'start', naturalLanguage: 'work' })).retryable, true);
  assert.equal((await s.respond({ type: 'retry' })).phase, 'confirm_merge');
  assert.equal(starts, 2);
});
