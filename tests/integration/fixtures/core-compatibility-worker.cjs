// Deterministic provider fixture; real Studio workers, runtime and Code processes.
const fs = require('node:fs');
const path = require('node:path');
const { createTaskExecution } = require('@openhilo/ai-contracts');
const { createDispatcher } = require('@openhilo/runtime/dispatcher');
const { createCodeExecutor } = require('@openhilo/code-local');

exports.createComposition = request => {
  const home = process.env.STUDIO_COMPAT_HOME;
  const workdir = request.kind === 'resume-worker'
    ? JSON.parse(fs.readFileSync(path.join(request.input.runDir, 'run.json'))).workdir
    : request.input.workdir;
  const mode = fs.readFileSync(path.join(workdir, 'mode'), 'utf8');
  return {
    runsDir: path.join(home, 'runs'), intentsDir: path.join(home, 'intents'),
    populateSnapshot({ snapshotDir }) {
      fs.copyFileSync(path.join(home, 'intents', 'fixture.itt.impl.json'), path.join(snapshotDir, 'fixture.itt.impl.json'));
    },
    createResources(context, ports) {
      return { executor: createDispatcher({ ...ports, runId: context.runId, workdir: context.workdir,
        codeExecutor: createCodeExecutor(context.workdir),
        aiExecutor: { id: 'studio.compatibility.fixture', capabilities: ['questions', 'structured_output', 'workspace'],
          async start(request, host) {
            const budget = ['question', 'timeout'].includes(mode) ? 600 : undefined;
            return createTaskExecution(request, { ...host,
              ...(budget ? { deadlineAt: new Date(Date.now() + budget).toISOString() } : {}),
              monitoring: { heartbeatMs: 50, slowAfterMs: 100, stalledAfterMs: 300, stopGraceMs: 100 },
            }, async operation => {
              fs.appendFileSync(path.join(context.workdir, 'ai-calls'), 'call\n');
              operation.emit({ type: 'progress', message: 'compatibility progress before completion' });
              if (mode === 'ai' && !fs.existsSync(path.join(context.workdir, 'repaired')))
                return { status: 'failed', error: { code: 'fixture_failure', message: 'Repair then explicitly retry', retryable: true, safeToReplay: false }, artifacts: [] };
              try {
                if (mode === 'provider-cancel') return { status: 'cancelled', reason: 'Confirmed provider cancellation' };
                if (['question', 'stop-ai'].includes(mode)) await operation.ask({ id: 'answer', prompt: 'Continue?', answer: 'text' });
                if (mode === 'question') {
                  operation.emit({ type: 'progress', message: 'compatibility live stream after answer' });
                  await operation.ask({ id: 'confirm', prompt: 'Finish?', answer: 'text' });
                }
                if (mode === 'timeout') await new Promise(resolve => {
                  if (operation.signal.aborted) resolve();
                  else operation.signal.addEventListener('abort', resolve, { once: true });
                });
                if (!operation.signal.aborted) fs.appendFileSync(path.join(context.workdir, 'ai-effects'), 'done\n');
                return { status: 'completed', outputs: mode === 'shape' ? {plan:{queries:[]}} : {}, artifacts: [] };
              } finally { fs.writeFileSync(path.join(context.workdir, 'ai-cleanup'), 'closed'); }
            });
          },
        },
      }) };
    },
  };
};
