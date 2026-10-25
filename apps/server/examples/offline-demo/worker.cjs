const fs = require('node:fs');
const path = require('node:path');
const { createDispatcher } = require('@openhilo/runtime/dispatcher');
const { createCodeExecutor } = require('@openhilo/code-local');
const { Snapshotter } = require('@openhilo/platform-services/brain-snapshot');
const { createOfflineExecutor, identity } = require('./ai.cjs');

exports.createComposition = (request) => {
  const home = process.env.INTENTORCH_DEMO_HOME;
  if (!home || !path.isAbsolute(home)) throw new Error('An explicit absolute demo home is required');
  if (request.kind === 'resume-worker') {
    const saved = JSON.parse(fs.readFileSync(path.join(request.input.runDir, 'run.json'), 'utf8'));
    if (
      saved.application?.id !== 'offline-demo' ||
      saved.application.version !== 1 ||
      saved.aiExecutorId !== identity
    ) {
      throw new Error('Saved run requires a different application or AI executor');
    }
  }
  return {
    runsDir: path.join(home, 'runs'),
    intentsDir: path.join(home, 'intents'),
    receipt: { application: { id: 'offline-demo', version: 1 }, aiExecutorId: identity },
    populateSnapshot(context) {
      new Snapshotter({
        ittHome: home,
        entryFile: path.resolve(home, 'intents', request.input.ittPath),
        snapshotDir: context.snapshotDir,
      }).collect();
    },
    createResources(context, ports) {
      return {
        executor: createDispatcher({
          ...ports,
          runId: context.runId,
          workdir: context.workdir,
          aiExecutor: createOfflineExecutor(),
          codeExecutor: createCodeExecutor(context.workdir),
        }),
      };
    },
  };
};
