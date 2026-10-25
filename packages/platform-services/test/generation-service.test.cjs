const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTaskExecution } = require('@openhilo/ai-contracts');
const { GenerationSession } = require('@openhilo/platform-services/generation-session');
const { createGenerationService } = require('@openhilo/platform-services/generation-service');
const { createFileSessionStorage } = require('@openhilo/platform-services/generation-storage');
const deferred = () => { let resolve; return { promise: new Promise(r => resolve = r), resolve: value => resolve(value) }; };
async function fixture(t, work, aiHost) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-host-'));
  const sessionsDir = path.join(root, 'sessions'), storage = createFileSessionStorage(sessionsDir);
  const services = { checkoutWorktree: () => root, assertWorktreeOwner() {}, returnWorktree() { archives++; return root; },
    async runPreflight() { return { ok: true, added: [], modified: [], deleted: [], contents: {}, diffs: {} }; }, async executeMerge() {} };
  let starts = 0, restores = 0, archives = 0, releases = 0;
  const executor = { id: 'offline', capabilities: ['workspace', 'questions', 'structured_output'],
    async start(request, host) { starts++; return createTaskExecution(request, host, context => work(context, request, host)); },
    async releaseSession() { releases++; },
  };
  const options = { storage,
    create(_input, id = randomUUID()) { return GenerationSession.create({ maxClarificationRounds: 2, maxFeedbackRounds: 2,
      workspace: root, sessionDir: path.join(sessionsDir, id), publicationDir: path.join(root, 'intents'), services, aiExecutor: executor, aiHost }, id); },
    inspect: data => GenerationSession.fromJSON(data),
    restore(data) { restores++; const session = GenerationSession.fromJSON(data); session.bindServices(services); session.bindAiExecutor(executor); return session; },
  };
  const hosts = [];
  const host = createGenerationService(options); hosts.push(host);
  t.after(async () => { await Promise.all(hosts.map(h => h.close().catch(() => {}))); await fs.rm(root, { recursive: true, force: true }); });
  return { root, storage, services, options, host, hosts, executor, stats: () => ({ starts, restores, archives, releases }) };
}
const completed = () => ({ status: 'completed', outputs: { entries: ['demo/report'] }, artifacts: [], session: { executorId: 'offline', version: 1, opaqueId: 'conversation' } });

test('review conversation keeps the draft, answers and continuation; retries do not launch duplicate revisions', async t => {
  const gate=deferred(),started=deferred(),requests=[],workspaces=[];
  const f=await fixture(t,async(ctx,request,host)=>{
    requests.push(request);workspaces.push(host.workspace.uri);
    if(requests.length===2){started.resolve();await gate.promise;assert.equal(await ctx.ask({id:'revision-question',prompt:'Which format?',answer:'text'}),'Short');}
    return completed();
  });
  f.executor.capabilities.push('continue');
  const {sessionId}=await f.host.start({naturalLanguage:'Create a report'});await f.host.drain();
  const initial=await f.host.read(sessionId);
  await assert.rejects(f.host.respond(sessionId,{type:'feedback',reviewId:initial.reviewId,message:'  '}),/Describe/);
  await assert.rejects(f.host.respond(sessionId,{type:'feedback',reviewId:'stale',message:'Change'}),/changed/);
  const input={type:'feedback',reviewId:initial.reviewId,message:'Use a short report'};
  assert.equal((await f.host.respond(sessionId,input)).phase,'cc_running');
  await f.host.respond(sessionId,input);
  await assert.rejects(f.host.respond(sessionId,{...input,message:'Other edit'}),/different/);
  await assert.rejects(f.host.respond(sessionId,{type:'feedback',reviewId:'new',message:'Another edit'}),/changed/);
  await started.promise;
  assert.equal(f.stats().starts,2);assert.equal(f.stats().archives,0);
  assert.match(requests[1].instruction,/Use a short report/);
  assert.equal(requests[1].continuation.opaqueId,'conversation');
  assert.equal(workspaces[0],workspaces[1]);
  gate.resolve();await f.host.drain();
  assert.equal((await f.host.read(sessionId)).phase,'cc_waiting_for_answer');
  const revised=await f.host.respond(sessionId,{type:'mcp_answer',questionId:'revision-question',answer:'Short'});
  assert.equal(revised.phase,'confirm_merge');assert.notEqual(revised.reviewId,initial.reviewId,'even identical candidate bytes need a new approval after conversation');
  await assert.rejects(f.host.respond(sessionId,{type:'merge_approve',reviewId:initial.reviewId}),/current review/);
  assert.equal((await f.host.respond(sessionId,input)).reviewId,revised.reviewId);
  assert.equal(f.stats().starts,2);
  await f.host.close();
  const other=createGenerationService(f.options);f.hosts.push(other);
  assert.equal((await other.read(sessionId)).revisionRequests[0].message,input.message);
  await other.respond(sessionId,{type:'feedback',reviewId:revised.reviewId,message:'Add a title'});await other.drain();
  assert.match(requests[2].instruction,/Use a short report/);assert.match(requests[2].instruction,/Add a title/);assert.match(requests[2].instruction,/Which format/);assert.match(requests[2].instruction,/Short/);
  const finalReview=await other.read(sessionId);
  const done=await other.respond(sessionId,{type:'merge_approve',reviewId:finalReview.reviewId});
  assert.equal(done.phase,'done');assert.deepEqual(done.entries,['demo/report']);assert.equal(f.stats().starts,3);
});

test('after a full pool is released, reopening the failed request is read-only and a new submission can start', async t => {
  const { WorktreePool } = require('@openhilo/platform-services/worktree-pool');
  const { git } = require('../dist/publication');
  const f = await fixture(t, async () => completed());
  const brainDir = path.join(f.root, 'brain');
  await fs.mkdir(brainDir);
  git(brainDir, ['init', '-b', 'main']);
  git(brainDir, ['config', 'user.name', 'Fixture']);
  git(brainDir, ['config', 'user.email', 'fixture@local']);
  git(brainDir, ['commit', '--allow-empty', '-m', 'fixture']);
  const pool = new WorktreePool({ brainDir, poolDir: path.join(f.root, 'pool'), size: 1 });
  Object.assign(f.services, {
    checkoutWorktree: id => pool.checkout(id),
    assertWorktreeOwner: (dir, id) => pool.assertOwner(dir, id),
    returnWorktree: (dir, id) => pool.release(dir, id),
  });
  const owner = await f.host.start({ naturalLanguage: 'First candidate' });
  await f.host.drain();
  const failed = await f.host.start({ naturalLanguage: 'Keep this request for another submission' });
  await f.host.drain();
  const savedFailure = await f.host.read(failed.sessionId);
  assert.equal(savedFailure.phase, 'error');
  assert.deepEqual(savedFailure.blockingSessionIds, [owner.sessionId]);
  assert.equal(f.stats().starts, 1, 'capacity rejection must not invoke AI');
  assert.equal((await f.host.respond(owner.sessionId, { type: 'merge_reject' })).phase, 'done');
  assert.equal(pool.snapshot()['ws-01'].status, 'vacant');
  assert.deepEqual(await f.host.read(failed.sessionId), savedFailure, 'a saved failure is historical, not current pool occupancy');
  assert.equal(f.stats().starts, 1, 'opening history must not replay a request');
  const next = await f.host.start({ naturalLanguage: savedFailure.naturalLanguage });
  await f.host.drain();
  assert.notEqual(next.sessionId, failed.sessionId);
  assert.equal((await f.host.read(next.sessionId)).phase, 'confirm_merge');
  assert.equal(f.stats().starts, 2);
  assert.equal(pool.snapshot()['ws-01'].sessionId, next.sessionId);
  await f.host.respond(next.sessionId, { type: 'merge_reject' });
});

test('generation history discovers persisted review tasks without restoring executors and isolates unreadable records', async t => {
  const f = await fixture(t, async () => completed());
  const original = await f.host.start({ naturalLanguage: 'Find this task after leaving the page' });
  await f.host.drain(); await f.host.close();
  const other = createGenerationService(f.options); f.hosts.push(other);
  let page = await other.list();
  assert.equal(page.total, 1);
  assert.equal(page.sessions[0].sessionId, original.sessionId);
  assert.equal(page.sessions[0].phase, 'confirm_merge');
  assert.equal(page.sessions[0].naturalLanguage, 'Find this task after leaving the page');
  assert.equal('config' in page.sessions[0], false);
  assert.equal(f.stats().starts, 1); assert.equal(f.stats().restores, 0);
  const corrupt = path.join(f.root, 'sessions', 'corrupt');
  await fs.mkdir(corrupt); await fs.writeFile(path.join(corrupt, 'session.json'), '{broken');
  page = await other.list({ limit: 1 });
  const next = await other.list({ offset: 1, limit: 1 });
  assert.equal(page.total, 2); assert.equal(next.total, 2);
  const records = [...page.sessions, ...next.sessions];
  assert.equal(new Set(records.map(item => item.sessionId)).size, 2);
  assert.equal(records.find(item => item.sessionId === 'corrupt').phase, 'unavailable');
  assert.equal(records.find(item => item.sessionId === original.sessionId).phase, 'confirm_merge');
  assert.equal((await other.list({ offset: 2 })).sessions.length, 0);
  await assert.rejects(other.list({ limit: 101 }), /Invalid/);
  await assert.rejects(other.list({ offset: -1 }), /Invalid/);
  assert.equal(f.stats().starts, 1); assert.equal(f.stats().restores, 0);
});

test('generation history reports unsupported storage instead of presenting an empty history', async t => {
  const f = await fixture(t, async () => completed());
  const service = createGenerationService({ ...f.options, storage: { load: f.storage.load, save: f.storage.save } });
  f.hosts.push(service);
  await assert.rejects(service.list(), error => error.statusCode === 501);
});

test('new file storage lists empty history and excludes unrelated directories and directory symlinks', async t => {
  const f = await fixture(t, async () => completed());
  assert.deepEqual(await f.storage.list({ offset: 0, limit: 20 }), { entries: [], total: 0 });
  const sessions = path.join(f.root, 'sessions');
  await fs.mkdir(path.join(sessions, 'empty'), { recursive: true });
  await fs.symlink(f.root, path.join(sessions, 'linked'));
  await fs.writeFile(path.join(sessions, 'README.txt'), 'not a task');
  assert.deepEqual(await f.storage.list({ offset: 0, limit: 20 }), { entries: [], total: 0 });
});

test('start returns a durable session before AI responds and polling exposes live health without replay', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, async ctx => { ctx.emit({ type: 'phase', phase: 'model' }); entered.resolve(); await finish.promise; return completed(); },
    () => ({ monitoring: { heartbeatMs: 5 } }));
  const pending = f.host.start({ naturalLanguage: 'Slow work' });
  let timer;
  try {
    await entered.promise;
    const started = await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Start is blocked on the AI response')), 1000);
    })]);
    assert.equal(started.step.phase, 'cc_running');
    assert.equal(started.step.naturalLanguage, 'Slow work');
    assert.ok(await f.storage.load(started.sessionId));
    let step;
    for (let attempt = 0; attempt < 100; attempt++) {
      step = await f.host.read(started.sessionId);
      if (step.aiHealth) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(step.phase, 'cc_running');
    assert.equal(step.naturalLanguage, 'Slow work');
    assert.equal(step.aiHealth.phase, 'model');
    const listed = await f.host.list();
    assert.equal(listed.sessions[0].sessionId, started.sessionId);
    assert.equal(listed.sessions[0].phase, 'cc_running');
    assert.equal(listed.sessions[0].naturalLanguage, 'Slow work');
    assert.equal(f.stats().restores, 0);
    await f.host.respond(started.sessionId, { type: 'start', naturalLanguage: 'Duplicate' });
    assert.equal(f.stats().starts, 1);
    finish.resolve(); await f.host.drain();
    assert.equal((await f.host.read(started.sessionId)).phase, 'confirm_merge');
    assert.equal((await f.host.read(started.sessionId)).naturalLanguage, 'Slow work');
  } finally { clearTimeout(timer); finish.resolve(); await pending; }
});

test('closing an unanswered live session cancels AI, persists a terminal interruption and retains the worktree', async t => {
  let effects = 0;
  const f = await fixture(t, async ctx => { await ctx.ask({ id: 'q', prompt: 'Proceed?', answer: 'text' }); effects++; return completed(); });
  const { sessionId, step } = await f.host.start({ naturalLanguage: 'Work' });
  assert.equal(step.phase, 'cc_running');
  await f.host.drain();
  assert.equal((await f.host.read(sessionId)).phase, 'cc_waiting_for_answer');
  await f.host.close();
  const saved = await f.storage.load(sessionId);
  assert.equal(saved.phase, 'error'); assert.equal(saved.lastError.retryable, false); assert.equal(saved.pendingMcpQuestion, undefined);
  assert.equal(saved.worktreePath, f.root); assert.equal(f.stats().archives, 0); assert.equal(effects, 0);
  await assert.rejects(f.host.respond(sessionId, { type: 'mcp_answer', questionId: 'q', answer: 'yes' }), /closed/);
  const other = createGenerationService(f.options); f.hosts.push(other);
  assert.equal((await other.read(sessionId)).phase, 'error'); assert.equal(f.stats().restores, 0); assert.equal(f.stats().starts, 1);
});

test('a candidate survives controlled shutdown and read-only polling never constructs its executor', async t => {
  const f = await fixture(t, async () => completed());
  const started = await f.host.start({ naturalLanguage: 'Work' });
  assert.equal(started.step.phase, 'cc_running');
  await f.host.drain();
  assert.equal((await f.host.read(started.sessionId)).phase, 'confirm_merge');
  await f.host.close(); assert.equal(f.stats().releases, 1); assert.equal(f.stats().archives, 0);
  const other = createGenerationService(f.options); f.hosts.push(other);
  assert.equal((await other.read(started.sessionId)).phase, 'confirm_merge'); assert.equal(f.stats().restores, 0);
  assert.equal((await other.read(started.sessionId)).naturalLanguage, 'Work');
  assert.equal((await other.respond(started.sessionId, { type: 'merge_reject' })).phase, 'done');
  assert.equal(f.stats().archives, 1); assert.equal(f.stats().starts, 1);
});

test('shutdown while start is running cancels and drains the accepted operation without starting another attempt', async t => {
  const entered = deferred(); let effects = 0;
  const f = await fixture(t, async ctx => { entered.resolve(); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true })); effects++; return { status: 'cancelled', reason: 'shutdown' }; });
  const pending = f.host.start({ naturalLanguage: 'Work' });
  await entered.promise; await f.host.close();
  const result = await pending; assert.equal(result.step.phase, 'cc_running');
  assert.equal((await f.storage.load(result.sessionId)).phase, 'error');
  assert.equal((await f.storage.load(result.sessionId)).lastError.retryable, false); assert.equal(f.stats().starts, 1); assert.equal(effects, 1);
});

test('closing during creation prevents subsequent AI work and closes the newly returned session', async t => {
  const f = await fixture(t, async () => completed()), entered = deferred(), gate = deferred();
  const service = createGenerationService({ ...f.options, async create(input) { entered.resolve(); await gate.promise; return f.options.create(input); } }); f.hosts.push(service);
  const starting = service.start({ naturalLanguage: 'Work' }); const failed = assert.rejects(starting, /closed/);
  await entered.promise; const closing = service.close(); gate.resolve(); await Promise.all([closing, failed]);
  assert.equal(f.stats().starts, 0); assert.equal(f.stats().archives, 0);
});

test('duplicate ids do not overwrite or cancel an existing session', async t => {
  const f = await fixture(t, async ctx => { await ctx.ask({ id: 'q', prompt: 'Proceed?', answer: 'text' }); return completed(); });
  const service = createGenerationService({ ...f.options, create: input => f.options.create(input, 'same') }); f.hosts.push(service);
  const first = await service.start({ naturalLanguage: 'Original' });
  await service.drain();
  const original = await f.storage.load('same');
  await assert.rejects(service.start({ naturalLanguage: 'Duplicate' }), /already in use/);
  assert.deepEqual(await f.storage.load('same'), original); assert.equal((await service.read(first.sessionId)).phase, 'cc_waiting_for_answer');
  assert.equal(f.stats().starts, 1);
});

test('shutdown drains already accepted publication and preserves its completed receipt', async t => {
  const f = await fixture(t, async () => completed()), entered = deferred(), gate = deferred();
  f.services.executeMerge = async () => { entered.resolve(); await gate.promise; };
  const started = await f.host.start({ naturalLanguage: 'Work' });
  await f.host.drain();
  const approval = f.host.respond(started.sessionId, { type: 'merge_approve', reviewId: (await f.host.read(started.sessionId)).reviewId });
  await entered.promise; const closing = f.host.close(); gate.resolve();
  assert.equal((await approval).phase, 'done'); await closing;
  assert.equal((await f.storage.load(started.sessionId)).phase, 'done'); assert.equal(f.stats().archives, 1);
});

test('restoration finishing after shutdown cannot accept a new operation', async t => {
  const f = await fixture(t, async () => completed()), entered = deferred(), gate = deferred();
  const started = await f.host.start({ naturalLanguage: 'Work' }); await f.host.drain(); await f.host.close();
  const other = createGenerationService({ ...f.options, async restore(saved) { entered.resolve(); await gate.promise; return f.options.restore(saved); } }); f.hosts.push(other);
  const responding = other.respond(started.sessionId, { type: 'merge_approve' }); const failed = assert.rejects(responding, /closed/);
  await entered.promise; const closing = other.close(); gate.resolve(); await Promise.all([failed, closing]);
  assert.equal(f.stats().starts, 1); assert.equal(f.stats().archives, 0); assert.equal((await f.storage.load(started.sessionId)).phase, 'confirm_merge');
});

test('stable creation receipts deduplicate concurrent retries and recover after host restart without replaying AI', async t => {
  const f = await fixture(t, async () => completed());
  const requestId = randomUUID(), input = { requestId, naturalLanguage: 'Create once despite a lost receipt' };
  const [first, second] = await Promise.all([f.host.start(input), f.host.start(input)]);
  assert.equal(first.sessionId, requestId); assert.equal(second.sessionId, requestId);
  await f.host.drain();
  assert.equal(f.stats().starts, 1);
  assert.equal((await f.host.list()).total, 1);
  await f.host.close();
  const restarted = createGenerationService(f.options); f.hosts.push(restarted);
  const recovered = await restarted.start(input);
  assert.equal(recovered.sessionId, requestId); assert.equal(recovered.step.phase, 'confirm_merge');
  assert.equal(f.stats().starts, 1); assert.equal(f.stats().restores, 0);
  await assert.rejects(restarted.start({ ...input, naturalLanguage: 'A different request' }), e => e.statusCode === 409);
  assert.equal((await restarted.list()).total, 1);
});

test('reusing an in-flight creation identity for different input fails before another execution starts', async t => {
  const f = await fixture(t, async () => completed()), requestId = randomUUID();
  const first = f.host.start({ requestId, naturalLanguage: 'Original request' });
  await assert.rejects(f.host.start({ requestId, naturalLanguage: 'Conflicting request' }), e => e.statusCode === 409);
  await first; await f.host.drain();
  assert.equal(f.stats().starts, 1);
});

test('initial persistence failure releases the unstarted session so the same request can recover', async t => {
  const f = await fixture(t, async () => completed()), save = f.storage.save;
  let unavailable = true;
  f.storage.save = async (...args) => {
    if (unavailable) throw Object.assign(new Error('QA disk is read-only'), { code: 'EACCES' });
    return save(...args);
  };
  const input = { requestId: randomUUID(), naturalLanguage: 'Create after storage recovers' };
  await assert.rejects(f.host.start(input), /read-only/);
  assert.equal(f.stats().starts, 0);
  assert.equal(await f.storage.load(input.requestId), null);
  unavailable = false;
  assert.equal((await f.host.start(input)).sessionId, input.requestId);
  await f.host.drain();
  assert.equal(f.stats().starts, 1);
  assert.equal((await f.host.list()).total, 1);
});

test('an initial snapshot written before storage rejects is retained without starting or replaying AI', async t => {
  const f = await fixture(t, async () => completed()), save = f.storage.save;
  let initial;
  f.storage.save = async (...args) => { initial ??= JSON.parse(JSON.stringify(args[1])); await save(...args); throw new Error('QA write receipt lost'); };
  const input = { requestId: randomUUID(), naturalLanguage: 'Do not replay uncertain storage writes' };
  await assert.rejects(f.host.start(input), /receipt lost/);
  const saved = await f.storage.load(input.requestId);
  assert.deepEqual(saved, initial);
  f.storage.save = save;
  await assert.rejects(f.host.start(input), e => e.statusCode === 409);
  await f.host.close();
  assert.deepEqual(await f.storage.load(input.requestId), saved);
  assert.equal(f.stats().starts, 0);
});

test('grouped history counts all pages and paginates after grouping without starting or restoring work', async t => {
  const snapshots = Array.from({ length: 126 }, (_, index) => ({ id: `task-${index}`, step: {
    phase: index < 103 ? 'done' : index < 124 ? 'confirm_merge' : index === 124 ? 'cc_running' : 'error',
    naturalLanguage: `Request ${index}`, ...(index < 80 ? { savedPath: 'demo/report' } : {}),
  } }));
  const entries = snapshots.map(item => ({ id: item.id, updatedAt: '2026-10-13T12:00:00.000Z' }));
  let restores = 0, starts = 0;
  const host = createGenerationService({
    storage: { async list({ offset, limit }) { return { entries: entries.slice(offset, offset + limit), total: entries.length }; }, async load(id) { return snapshots.find(s => s.id === id); }, async save() {} },
    create() { starts++; throw Error('must not start'); }, restore() { restores++; throw Error('must not restore'); },
    inspect: snapshot => ({ currentStep: () => snapshot.step }),
  });
  t.after(() => host.close());
  const recent = await host.list({ group: 'recent', limit: 5 });
  assert.equal(recent.sessions.length, 5); assert.equal(recent.allTotal, 126);
  assert.deepEqual(recent.counts, { attention: 21, active: 1, published: 80, ended: 23, error: 1 });
  const attention = await host.list({ group: 'attention', limit: 20 });
  assert.equal(attention.total, 21); assert.equal(attention.sessions[0].sessionId, 'task-103');
  assert.equal((await host.list({ group: 'attention', offset: 20, limit: 20 })).sessions[0].sessionId, 'task-123');
  await assert.rejects(host.list({ group: 'nonsense' }), /Invalid/);
  assert.equal(starts, 0); assert.equal(restores, 0);
});

test('deleting terminal history persists across storage reopen without deleting published files or snapshots', async t => {
 const f = await fixture(t, async () => completed());
 const {sessionId} = await f.host.start({naturalLanguage:'Disposable history'}); await f.host.drain();
 await assert.rejects(f.host.removeHistory(sessionId), {statusCode:409});
 await f.host.respond(sessionId,{type:'merge_reject'}); await f.host.drain();
 const original = await f.storage.load(sessionId);
 await f.host.removeHistory(sessionId);
 const reopened = createFileSessionStorage(path.join(f.root,'sessions'));
 assert.equal((await reopened.list({offset:0,limit:20})).total,0);
 assert.deepEqual(await reopened.load(sessionId),original);
 assert.equal((await f.host.list({group:'recent'})).allTotal,0);
 await f.host.removeHistory(sessionId);
 await f.host.restoreHistory(sessionId);
 assert.equal((await f.host.list({group:'recent'})).allTotal,1);
 await assert.rejects(f.host.removeHistory('does-not-exist'), {statusCode:404});
});

test('history deletion refuses a live AI task and retains it in discovery', async t => {
 const gate=deferred(); const f=await fixture(t, async()=>{ await gate.promise; return completed(); });
 const {sessionId}=await f.host.start({naturalLanguage:'Still running'});
 try { await assert.rejects(f.host.removeHistory(sessionId),{statusCode:409}); assert.equal((await f.host.list({group:'recent'})).allTotal,1); }
 finally { gate.resolve(); await f.host.drain(); }
});

test('manual stop cancels only the selected waiting generation, persists and never replays', async t => {
  let effects = 0;
  const f = await fixture(t, async ctx => { await ctx.ask({id: 'q', prompt: 'Proceed?', answer: 'text'}); effects++; return completed(); });
  const first = await f.host.start({naturalLanguage: 'Stop this task'});
  const second = await f.host.start({naturalLanguage: 'Keep this task'});
  await f.host.drain();
  const waiting = await f.host.read(first.sessionId);
  assert.equal(waiting.phase, 'cc_waiting_for_answer');
  assert.ok(waiting.aiHealth.remainingMs > 43190000, 'generation must not impose a hidden 20-minute limit');
  const stopped = await f.host.stop(first.sessionId);
  assert.equal(stopped.phase, 'error');
  assert.match(stopped.message, /stopped by user/);
  assert.equal(stopped.retryable, false);
  assert.equal((await f.host.stop(first.sessionId)).phase, 'error');
  assert.equal((await f.host.read(second.sessionId)).phase, 'cc_waiting_for_answer');
  assert.equal(f.stats().starts, 2);
  assert.equal(f.stats().restores, 0);
  assert.equal(effects, 0);
  const saved = await f.storage.load(first.sessionId);
  assert.equal(saved.pendingMcpQuestion, undefined);
  assert.equal(saved.worktreePath, f.root);
  assert.equal(f.stats().archives, 0);
  await assert.rejects(f.host.stop('missing'), error => error.statusCode === 404);
});

test('generation exposes bounded live output and restores it after terminal restart', async t => {
 const gate=deferred(),ready=deferred();
 const f=await fixture(t,async ctx=>{
  ctx.emit({type:'progress',message:'x'.repeat(70000)});
  ctx.emit({type:'progress',message:'\nVisible provider update'});
  ctx.emit({type:'tool_started',callId:'tool',tool:'command'});
  ready.resolve();await gate.promise;
  ctx.emit({type:'tool_finished',callId:'tool',tool:'command',outcome:'completed'});
  return completed();
 });
 const started=await f.host.start({naturalLanguage:'Test output'});await ready.promise;
 const live=await f.host.read(started.sessionId);
 assert.equal(live.aiOutput.length,64000);assert.match(live.aiOutput,/Visible provider update/);assert.match(live.aiOutput,/Tool started: command/);
 gate.resolve();await f.host.drain();
 const done=await f.host.read(started.sessionId);assert.match(done.aiOutput,/Tool completed: command/);
 await f.host.close();const next=createGenerationService(f.options);f.hosts.push(next);
 assert.equal((await next.read(started.sessionId)).aiOutput,done.aiOutput);
 assert.equal(f.stats().starts,1);
});
