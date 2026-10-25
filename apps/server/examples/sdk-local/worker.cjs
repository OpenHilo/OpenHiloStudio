const fs = require('node:fs');
const path = require('node:path');
const { createDispatcher } = require('@openhilo/runtime/dispatcher');
const { createCodeExecutor } = require('@openhilo/code-local');
const { Snapshotter } = require('@openhilo/platform-services/brain-snapshot');
const { resolveRunOpts } = require('@openhilo/platform-services/worker-run-path');
const { EntityStore } = require('@openhilo/platform-services/entity-store');
const { createPlatformToolHost } = require('@openhilo/platform-services/tools');
const { readSelection, createExecutor } = require('./config.cjs');

exports.createComposition = request => {
  const selection = readSelection(process.env.INTENTORCH_SDK_HOME);
  if (selection.identity !== process.env.INTENTORCH_SDK_IDENTITY) throw new Error('SDK deployment selection changed; restart the host before launching work');
  const home = selection.home, runsDir = path.join(home, 'runs'), intentsDir = path.join(home, 'intents');
  if (request.kind === 'resume-worker') {
    const runDir = fs.realpathSync(request.input.runDir);
    if (!runDir.startsWith(runsDir + path.sep)) throw new Error('Saved run is outside this SDK deployment');
    const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    if (saved.application?.id !== 'generic' || saved.application.version !== 1 || saved.aiExecutorId !== selection.identity)
      throw new Error('Saved run requires explicit application or SDK configuration migration');
  }
  const aiExecutor = createExecutor(selection);
  return {
    runsDir, intentsDir,
    receipt: { application: selection.application, aiExecutorId: selection.identity },
    populateSnapshot(context) {
      const resolved = resolveRunOpts(request.input.ittPath, intentsDir);
      if (!resolved) throw new Error('Intent file is unavailable');
      new Snapshotter({ ittHome: home, entryFile: resolved.entryFile, snapshotDir: context.snapshotDir }).collect();
    },
    createTools() {
      const store = new EntityStore(path.join(home, 'entities.db'));
      try { return { tools: createPlatformToolHost(store, { intentsDir }), close: () => store.close() }; }
      catch (error) { store.close(); throw error; }
    },
    createResources(context, ports) {
      return { executor: createDispatcher({ ...ports, runId: context.runId, workdir: context.workdir,
        aiExecutor, codeExecutor: createCodeExecutor(context.workdir) }) };
    },
  };
};
