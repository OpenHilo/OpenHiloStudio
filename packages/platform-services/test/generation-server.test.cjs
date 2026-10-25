const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GenerationServerDriver } = require('@openhilo/platform-services/generation-server');
const { createFileSessionStorage } = require('@openhilo/platform-services/generation-storage');
function saved(id = 'session') { return { id, config: { maxClarificationRounds: 2, maxFeedbackRounds: 2, workspace: '/unused' }, phase: 'cc_running', round: 0, feedbackRoundsUsed: 0, naturalLanguage: '', sessionDir: '/unused' }; }
function memory(snapshot = saved()) {
  let value = snapshot;
  return { async load() { return structuredClone(value); }, async save(_id, data) { value = structuredClone(data); } };
}
function session(run, snapshot = saved()) {
  let value = snapshot;
  return { config: snapshot.config, toJSON: () => structuredClone(value), currentStep: () => value.phase === 'error' ? { phase: 'error', ...value.lastError } : { phase: value.phase, round: value.round, maxRounds: 2 },
    async respond(input) { const next = await run(input); value = { ...value, phase: next.phase, round: 1 }; return next; } };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('an answer to a visible question waits for the initial receipt instead of being silently dropped', async () => {
  const driver = new GenerationServerDriver(), storage = memory(), writing = deferred(), release = deferred();
  let phase = 'cc_running', answers = 0;
  const s = { config: saved().config, currentStep: () => ({ phase, questionId: 'q1', question: 'Name?' }),
    toJSON: () => ({ ...saved(), phase, round: phase === 'cc_running' ? 0 : 1 }),
    async respond(input) {
      if (input.type === 'start') phase = 'cc_waiting_for_answer';
      else { assert.equal(input.questionId, 'q1'); assert.equal(input.answer, 'Alice'); answers++; phase = 'confirm_merge'; }
      return s.currentStep();
    } };
  const save = storage.save;
  storage.save = async (id, data) => {
    if (data.phase === 'cc_waiting_for_answer') { writing.resolve(); await release.promise; }
    return save(id, data);
  };
  const options = { sessions: new Map([['session', s]]), restore: () => s, onAsyncStep() {} };
  await driver.respond('session', { type: 'start', naturalLanguage: 'work' }, storage, options);
  await writing.promise;
  assert.equal((await driver.read('session', storage, options)).phase, 'cc_waiting_for_answer');
  const answered = driver.respond('session', { type: 'mcp_answer', questionId: 'q1', answer: 'Alice' }, storage, options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(answers, 0, 'persist the original question before applying its answer');
  release.resolve();
  assert.equal((await answered).phase, 'confirm_merge');
  assert.equal(answers, 1);
  assert.equal((await storage.load()).phase, 'confirm_merge');
  await driver.drain();
});

test('an answer before a question is available is explicitly rejected, not acknowledged as running', async () => {
  const driver = new GenerationServerDriver(), storage = memory(), gate = deferred();
  const s = session(async () => { await gate.promise; return { phase: 'done', savedPath: '/output' }; });
  const options = { sessions: new Map([['session', s]]), restore: () => s, onAsyncStep() {} };
  await driver.respond('session', { type: 'start', naturalLanguage: 'work' }, storage, options);
  try { await assert.rejects(driver.respond('session', { type: 'mcp_answer', questionId: 'old', answer: 'Alice' }, storage, options), /answer was not accepted/); }
  finally { gate.resolve(); await driver.drain(); }
});

test('concurrent starts claim once and persist completion before notification', async () => {
  const driver = new GenerationServerDriver(), storage = memory(), gate = deferred(); let calls = 0;
  const s = session(async () => { calls++; await gate.promise; return { phase: 'done', savedPath: '/output' }; });
  const notifications = [], sessions = new Map();
  const options = { sessions, restore: () => s, onAsyncStep: next => notifications.push(next) };
  const steps = await Promise.all([1, 2, 3].map(() => driver.respond('session', { type: 'start', naturalLanguage: 'work' }, storage, options)));
  assert.equal(calls, 1); assert.ok(steps.every(s => s.phase === 'cc_running'));
  assert.equal((await storage.load()).round, 1);
  gate.resolve(); await driver.drain();
  assert.equal((await storage.load()).phase, 'done'); assert.equal(notifications.length, 1); assert.equal(sessions.size, 0);
});

test('unexpected background failure is durable and cannot trigger another attempt', async () => {
  const driver = new GenerationServerDriver(), storage = memory(); let calls = 0;
  const s = session(async () => { calls++; throw new Error('Failure after a possible external effect'); });
  const options = { sessions: new Map(), restore: () => s, onAsyncStep(step) { step.retryable = true; step.message = 'Observer mutation'; } };
  await driver.respond('session', { type: 'start', naturalLanguage: 'work' }, storage, options); await driver.drain();
  const failure = await driver.read('session', storage, options);
  assert.equal(failure.phase, 'error'); assert.equal(failure.retryable, false);
  assert.match(failure.message, /possible external effect/);
  assert.equal((await storage.load()).lastError.message, failure.message);
  assert.deepEqual(await driver.respond('session', { type: 'retry' }, storage, options), failure); assert.equal(calls, 1);
});

test('failed terminal snapshot write remains visible to polling and observers cannot mask it', async () => {
  const driver = new GenerationServerDriver(), storage = memory(); let writes = 0;
  const save = storage.save; storage.save = async (...args) => { if (++writes > 1) throw new Error('Disk unavailable'); return save(...args); };
  const reported = [];
  const options = { restore: () => session(async () => ({ phase: 'done', savedPath: '/output' })),
    onAsyncStep() { throw new Error('Observer failed'); }, onBackgroundError: error => reported.push(error.message) };
  await driver.respond('session', { type: 'start', naturalLanguage: 'work' }, storage, options); await driver.drain();
  assert.deepEqual(await driver.read('session', storage, options), { phase: 'error', message: 'Disk unavailable', retryable: false, naturalLanguage: 'work' });
  assert.equal(reported.filter(x => x === 'Disk unavailable').length, 2); assert.ok(reported.includes('Observer failed'));
});

test('notification failure never overwrites a successful snapshot', async () => {
  const driver = new GenerationServerDriver(), storage = memory();
  const options = { restore: () => session(async () => ({ phase: 'done', savedPath: '/output' })), onAsyncStep() { throw new Error('Observer failed'); } };
  await driver.respond('session', { type: 'start', naturalLanguage: 'work' }, storage, options); await driver.drain();
  assert.equal((await storage.load()).phase, 'done');
});

test('separate driver instances do not share locks for identical session ids', async () => {
  const gate = deferred(); let calls = 0;
  const drivers = [new GenerationServerDriver(), new GenerationServerDriver()];
  await Promise.all(drivers.map(driver => driver.respond('session', { type: 'start', naturalLanguage: 'work' }, memory(), {
    restore: () => session(async () => { calls++; await gate.promise; return { phase: 'done', savedPath: '/output' }; }), onAsyncStep() {},
  })));
  assert.equal(calls, 2); gate.resolve(); await Promise.all(drivers.map(driver => driver.drain()));
});

test('file snapshots serialize writes, reject wrong identities and never hide corruption', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-storage-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = createFileSessionStorage(root);
  await Promise.all([1, 2, 3].map(round => storage.save('session', { ...saved(), round })));
  assert.equal((await storage.load('session')).round, 3);
  assert.deepEqual(await fs.readdir(path.join(root, 'session')), ['session.json']);
  assert.equal(await storage.load('missing'), null);
  await assert.rejects(storage.save('different', saved()), /identity/);
  await assert.rejects(storage.load('../session'), /Invalid session id/);
  await fs.writeFile(path.join(root, 'session', 'session.json'), '{broken');
  await assert.rejects(storage.load('session'), SyntaxError);
  await storage.save('session', saved());
  await fs.writeFile(path.join(root, 'session', 'session.json'), JSON.stringify(saved('another')));
  await assert.rejects(storage.load('session'), /identity/);
  assert.throws(() => createFileSessionStorage('.'), /explicit absolute path/);
});

test('driver and file storage preserve a live AI question through answer, review and rejection', async t => {
  const { GenerationSession } = require('@openhilo/platform-services/generation-session');
  const { createTaskExecution } = require('@openhilo/ai-contracts');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-server-flow-'));
  const store = createFileSessionStorage(path.join(root, 'sessions'));
  const driver = new GenerationServerDriver(); let starts = 0;
  const s = GenerationSession.fromJSON({ ...saved(), sessionDir: path.join(root, 'sessions', 'session'), config: {
    ...saved().config, workspace: root, publicationDir: path.join(root, 'published'),
    services: { checkoutWorktree: () => root, assertWorktreeOwner() {}, returnWorktree: () => root,
      async runPreflight() { return { ok: true, added: [], modified: [], deleted: [], contents: {}, diffs: {} }; }, async executeMerge() {} },
    aiExecutor: { id: 'offline', capabilities: ['workspace', 'questions', 'structured_output'], async start(request, host) {
      starts++; return createTaskExecution(request, host, async ctx => {
        assert.equal(await ctx.ask({ id: 'language', prompt: 'Language?', answer: 'text' }), 'English');
        return { status: 'completed', outputs: { entries: ['report'] }, artifacts: [] };
      });
    } },
  } });
  t.after(async () => { await driver.drain(); await s.flushPersistence(); await fs.rm(root, { recursive: true, force: true }); });
  await store.save('session', s.toJSON());
  const options = { sessions: new Map([['session', s]]), restore: () => { throw new Error('Live context must be retained'); }, onAsyncStep() {} };
  await driver.respond('session', { type: 'start', naturalLanguage: 'Write report' }, store, options); await driver.drain();
  assert.equal((await driver.read('session', store, options)).phase, 'cc_waiting_for_answer');
  assert.equal((await store.load('session')).pendingMcpQuestion.id, 'language');
  const review = await driver.respond('session', { type: 'mcp_answer', questionId: 'language', answer: 'English' }, store, options);
  assert.equal(review.phase, 'confirm_merge');
  assert.equal((await store.load('session')).phase, 'confirm_merge');
  assert.equal((await driver.respond('session', { type: 'merge_reject' }, store, options)).phase, 'done');
  assert.equal(starts, 1); assert.equal(options.sessions.size, 0);
});

test('failure snapshot waits for an already queued session write before replacing it', async () => {
  const driver = new GenerationServerDriver(), storage = memory(), gate = deferred();
  const s = session(async () => { throw new Error('Operation failed'); });
  s.flushPersistence = async () => { await gate.promise; await storage.save('session', { ...saved(), round: 1 }); };
  await driver.respond('session', { type: 'start', naturalLanguage: 'work' }, storage, { restore: () => s, onAsyncStep() {} });
  gate.resolve(); await driver.drain();
  assert.equal((await storage.load()).phase, 'error');
});
