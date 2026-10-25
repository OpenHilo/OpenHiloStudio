const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskExecution } = require('@openhilo/ai-contracts');
const { createAiQuestionService, readAiQuestions } = require('@openhilo/platform-services/ai-questions');
const request = (taskId = 'task') => ({ version: 1, taskId, instruction: 'Offline clarification', inputs: {}, output: {}, requiredCapabilities: ['questions'] });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-questions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'questions.json');
  return { root, filePath, service: createAiQuestionService({ filePath }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const key = q => ({ taskId: q.taskId, attemptId: q.attemptId, questionId: q.questionId });
function emitQuestion(host, task, id = 'q') { host.onEvent({ taskId: task.taskId, attemptId: host.attemptId, type: 'question', sequence: 1, timestamp: new Date().toISOString(), question: { id, prompt: 'Choose', answer: 'text' } }); }

test('questions arriving before attachment support multiple typed answers, correlation and durable duplicate receipts', async t => {
  const f = fixture(t), task = request(), host = f.service.host(task);
  const execution = createTaskExecution(task, host, async ctx => {
    const answers = await Promise.all([
      ctx.ask({ id: 'text', prompt: 'Which?', answer: 'text', options: [{ label: 'First', value: 'one' }], optionsMode: 'exclusive' }),
      ctx.ask({ id: 'json', prompt: 'Details?', answer: 'json' }),
    ]);
    assert.deepEqual(answers, ['one', { enabled: true }]);
    return { status: 'completed', outputs: {}, artifacts: [] };
  });
  await tick(); // Both questions emit before the accepted handle is attached.
  const [first, second] = f.service.list(); assert.equal(first.status, 'pending');
  assert.equal(await f.service.answer(key(first), 'one'), 'unavailable');
  f.service.attach(execution, task);
  assert.equal(await f.service.answer({ ...key(first), attemptId: 'wrong' }, 'one'), 'unknown_question');
  assert.equal(await f.service.answer(key(first), { wrong: true }), 'invalid_answer');
  assert.equal(await f.service.answer(key(first), 'custom'), 'invalid_answer');
  assert.equal(await f.service.answer(key(first), 'one'), 'accepted');
  assert.equal(await f.service.answer(key(second), { enabled: true }), 'accepted');
  assert.equal((await execution.result).status, 'completed'); await f.service.drain();
  assert.equal(await f.service.answer(key(first), 'different'), 'duplicate');
  assert.equal(readAiQuestions(f.filePath)[0].answer, 'one');
  assert.ok(readAiQuestions(f.filePath).every(q => q.status === 'answered'));
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
  const restored = createAiQuestionService({ filePath: f.filePath });
  assert.equal(await restored.answer(key(first), 'new'), 'duplicate');
  await f.service.close(); await restored.close();
});

test('concurrent submissions deliver once and an interrupted answer remains unknown after restart', async t => {
  const f = fixture(t), task = request(), host = f.service.host(task);
  emitQuestion(host, task); const question = f.service.list()[0];
  let calls = 0, release;
  const reply = new Promise(resolve => { release = resolve; });
  f.service.attach({ state: 'waiting_for_input', result: new Promise(() => {}), cancel: async () => {}, answer: async () => { calls++; return reply; } }, task);
  const first = f.service.answer(key(question), 'yes');
  assert.equal(readAiQuestions(f.filePath)[0].status, 'answering');
  assert.equal(await f.service.answer(key(question), 'no'), 'in_progress'); assert.equal(calls, 1);
  const interrupted = path.join(f.root, 'interrupted.json'); fs.copyFileSync(f.filePath, interrupted);
  const recovered = createAiQuestionService({ filePath: interrupted });
  assert.equal(recovered.list()[0].status, 'outcome_unknown');
  assert.equal(await recovered.answer(key(question), 'yes'), 'outcome_unknown');
  release('accepted'); assert.equal(await first, 'accepted');
  await f.service.close(); await recovered.close();
});

test('finished, cancelled and orphaned questions cannot be mistaken for live waiting tasks', async t => {
  const f = fixture(t), task = request(), host = f.service.host(task);
  const execution = createTaskExecution(task, host, async ctx => {
    await ctx.ask({ id: 'q', prompt: 'Choose', answer: 'text' });
    return { status: 'completed', outputs: {}, artifacts: [] };
  });
  f.service.attach(execution, task); await tick();
  const question = f.service.list()[0];
  const orphan = path.join(f.root, 'orphan.json'); fs.copyFileSync(f.filePath, orphan);
  const restored = createAiQuestionService({ filePath: orphan });
  assert.equal(restored.list()[0].status, 'closed');
  assert.equal(await restored.answer(key(question), 'later'), 'closed');
  await execution.cancel('user cancelled'); await tick();
  assert.equal(f.service.list()[0].status, 'closed');
  assert.equal(await f.service.answer(key(question), 'later'), 'closed');
  await f.service.close(); await restored.close();
});

test('storage failure before delivery prevents the effect; failure after delivery preserves an uncertain receipt', async t => {
  const f = fixture(t), task = request(), host = f.service.host(task); emitQuestion(host, task);
  let calls = 0, cancels = 0;
  f.service.attach({ state: 'waiting_for_input', result: new Promise(() => {}), cancel: async () => { cancels++; }, answer: async () => { calls++; return 'accepted'; } }, task);
  fs.writeFileSync(f.filePath, '{broken');
  await assert.rejects(f.service.answer(key(f.service.list()[0]), 'yes'), /JSON is invalid/);
  assert.equal(calls, 0); assert.equal(cancels, 1); assert.equal(host.signal.aborted, true);
  await assert.rejects(f.service.close());
  assert.throws(() => createAiQuestionService({ filePath: f.filePath }), /JSON is invalid/);

  const filePath = path.join(f.root, 'after.json'), service = createAiQuestionService({ filePath });
  const second = request('second'), secondHost = service.host(second); emitQuestion(secondHost, second);
  service.attach({ state: 'waiting_for_input', result: new Promise(() => {}), cancel: async () => {}, answer: async () => {
    fs.renameSync(filePath, path.join(f.root, 'before-failure.json')); fs.mkdirSync(filePath); return 'accepted';
  } }, second);
  await assert.rejects(service.answer(key(service.list()[0]), 'yes'));
  assert.equal(readAiQuestions(path.join(f.root, 'before-failure.json'))[0].status, 'answering');
  await assert.rejects(service.close());
});

test('question persistence failure before handle attachment explicitly aborts the accepted execution', async t => {
  const f = fixture(t), task = request(), host = f.service.host(task);
  fs.mkdirSync(f.filePath);
  const execution = createTaskExecution(task, host, async ctx => {
    await ctx.ask({ id: 'q', prompt: 'Choose', answer: 'text' });
    return { status: 'completed', outputs: {}, artifacts: [] };
  });
  await tick();
  assert.equal(host.signal.aborted, true);
  assert.throws(() => f.service.attach(execution, task));
  assert.equal((await execution.result).status, 'cancelled');
  await assert.rejects(f.service.close());
});

test('a throwing answer transport records uncertainty and cancels the stranded task', async t => {
  const f = fixture(t), task = request(), host = f.service.host(task); emitQuestion(host, task);
  let cancels = 0;
  f.service.attach({ state: 'waiting_for_input', result: new Promise(() => {}), cancel: async () => { cancels++; }, answer: async () => { throw new Error('Receipt lost'); } }, task);
  const question = f.service.list()[0];
  assert.equal(await f.service.answer(key(question), 'yes'), 'outcome_unknown');
  assert.equal(readAiQuestions(f.filePath)[0].status, 'outcome_unknown');
  assert.equal(host.signal.aborted, true); assert.equal(cancels, 1);
  assert.equal(await f.service.answer(key(question), 'retry'), 'outcome_unknown');
  await f.service.close();
});
