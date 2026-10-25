// Requires runtime + platform-services only. AI is cooperative in-memory work; no provider SDK.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { WorkerSupervisor } = require('@openhilo/platform-services/worker-supervisor');
const { readAiQuestions } = require('@openhilo/platform-services/ai-questions');
const resolved = name => JSON.stringify(require.resolve(name));

for (const disconnect of [false, true]) test(disconnect ? 'parent disconnect cancels a child waiting for an AI answer without replaying effects' : 'real runtime child persists AI questions, accepts correlated IPC answers and finishes its one effect before exit', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-question-runtime-'));
  const entryFile = path.join(root, 'workflow.itt.impl.json'), workerFile = path.join(root, 'worker.cjs');
  fs.writeFileSync(entryFile, JSON.stringify({ version: 2, entry: 'ai', nodes: {
    ai: { id: 'ai', type: 'call', executor: 'ai', intent: 'Clarify before acting', inputsFrom: {}, outputsTo: {}, outputs: {}, next: 'END' },
  } }));
  fs.writeFileSync(workerFile, `
    const Module = require('node:module'), original = Module._load;
    Module._load = function(name, ...args) {
      if (/ai-claude|ai-sdk|@intentorch|anthropic|openai|node-pty/.test(name)) throw new Error('Forbidden offline dependency: ' + name);
      return original.call(this, name, ...args);
    };
    globalThis.fetch = () => { throw new Error('External requests forbidden'); };
    const fs = require('node:fs'), path = require('node:path');
    const { startRun } = require(${resolved('@openhilo/runtime/run-service')});
    const { createDispatcher } = require(${resolved('@openhilo/runtime/dispatcher')});
    const { createTaskExecution } = require(${resolved('@openhilo/ai-contracts')});
    const { createAiQuestionService } = require(${resolved('@openhilo/platform-services/ai-questions')});
    const { createWorkerQuestionServer } = require(${resolved('@openhilo/platform-services/worker-questions')});
    const { sendWorkerMessage: send } = require(${resolved('@openhilo/platform-services/worker-protocol')});
    process.once('message', async opts => {
      let service, server;
      try {
        const result = await startRun({ intent: 'fixture', entryFile: opts.ittPath, workdir: opts.workdir, runsDir: path.join(opts.workdir, 'runs'), inputs: {},
          onRunCreated(runId, runDir) {
            service = createAiQuestionService({ filePath: path.join(runDir, 'ai-questions.json') });
            server = createWorkerQuestionServer((key, value) => service.answer(key, value), { onDisconnect: () => service.close() });
            void send({ type: 'started', runId, runDir });
          },
          populateSnapshot: ({ snapshotDir }) => fs.copyFileSync(opts.ittPath, path.join(snapshotDir, path.basename(opts.ittPath))),
          createResources: context => ({ executor: createDispatcher({ workdir: context.workdir, runId: context.runId, aiHost: service.host, onAiExecution: service.attach,
            aiExecutor: { id: 'offline.fixture', capabilities: ['structured_output', 'workspace', 'questions'], start: async (request, host) => createTaskExecution(request, host, async ctx => {
              const name = await ctx.ask({ id: 'name', prompt: 'Name?', answer: 'text' });
              const data = await ctx.ask({ id: 'data', prompt: 'Data?', answer: 'json' });
              fs.appendFileSync(path.join(opts.workdir, 'effects.jsonl'), JSON.stringify({ name, data }) + '\\n');
              return { status: 'completed', outputs: {}, artifacts: [] };
            }) },
          }) }),
        });
        await service.drain(); await server.drain();
        await send({ type: 'done', runId: result.runId, status: result.status });
        await service.close(); server.close(); process.exit(0);
      } catch (error) { console.error(error); await send({ type: 'error', message: String(error) }); process.exit(1); }
    });
  `);
  let child, exited, stderr = '', runDir;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill(); if (exited) await exited; fs.rmSync(root, { recursive: true, force: true }); });
  const manager = new WorkerSupervisor({ launch: () => ({ file: workerFile, options: { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] } }),
    fork(file, args, options) {
      child = fork(file, args, options); exited = once(child, 'exit'); child.stderr.on('data', data => { stderr += data; });
      child.on('message', message => { if (message.type === 'started') runDir = message.runDir; }); return child;
    }, handleSystemCall: async () => { throw new Error('No system call expected'); }, broadcaster: { publish() {}, closeAll() {} } });
  const runId = await manager.forkRun({ ittPath: entryFile, workdir: root, inputs: {} });
  async function waitForQuestion(id) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const item = readAiQuestions(path.join(runDir, 'ai-questions.json')).find(q => q.questionId === id);
      if (item) return { taskId: item.taskId, attemptId: item.attemptId, questionId: item.questionId };
      if (child.exitCode !== null) throw new Error(stderr);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Question timed out: ' + stderr);
  }
  const name = await waitForQuestion('name');
  if (disconnect) {
    child.disconnect(); await exited;
    assert.equal(fs.existsSync(path.join(root, 'effects.jsonl')), false);
    assert.equal(readAiQuestions(path.join(runDir, 'ai-questions.json'))[0].status, 'closed');
    assert.equal(manager.isActive(runId), false);
    return;
  }
  assert.equal(await manager.answerAiQuestion(runId, { ...name, attemptId: 'stale' }, 'wrong'), 'unknown_question');
  assert.equal(await manager.answerAiQuestion(runId, name, 42), 'invalid_answer');
  assert.equal(await manager.answerAiQuestion(runId, name, 'fixture'), 'accepted');
  assert.equal(await manager.answerAiQuestion(runId, name, 'overwrite'), 'duplicate');
  const data = await waitForQuestion('data');
  assert.equal(await manager.answerAiQuestion(runId, data, { enabled: true }), 'accepted');
  assert.deepEqual(await exited, [0, null], stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'))).status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'effects.jsonl'), 'utf8'), '{"name":"fixture","data":{"enabled":true}}\n');
  assert.ok(readAiQuestions(path.join(runDir, 'ai-questions.json')).every(q => q.status === 'answered'));
  assert.equal(await manager.answerAiQuestion(runId, data, null), 'unavailable');
});
