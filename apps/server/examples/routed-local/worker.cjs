const fs = require('node:fs');
const path = require('node:path');
const { createDispatcher } = require('@openhilo/runtime/dispatcher');
const { createCodeExecutor } = require('@openhilo/code-local');
const { Snapshotter } = require('@openhilo/platform-services/brain-snapshot');
const { resolveRunOpts } = require('@openhilo/platform-services/worker-run-path');
const { EntityStore } = require('@openhilo/platform-services/entity-store');
const { createPlatformToolHost } = require('@openhilo/platform-services/tools');
const { readSavedSelection, createExecutor } = require('./config.cjs');

exports.createComposition = request => {
  const home = fs.realpathSync(process.env.INTENTORCH_ROUTED_HOME), runsDir = path.join(home, 'runs'), intentsDir = path.join(home, 'intents');
  let identity = process.env.INTENTORCH_ROUTED_IDENTITY;
  let saved;
  if (request.kind === 'resume-worker') {
    const runDir = fs.realpathSync(request.input.runDir);
    if (!runDir.startsWith(runsDir + path.sep)) throw new Error('Saved run is outside this routed AI deployment');
    saved = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    if (saved.application?.id !== 'generic' || saved.application.version !== 1)
      throw new Error('Saved run requires explicit application migration');
    identity = saved.aiExecutorId;
  }
  const selection = readSavedSelection(home, identity);
  const aiExecutor = createExecutor(selection);
  if (saved && saved.ai_routing_identity !== aiExecutor.id) throw new Error('Saved run routing identity mismatch');
  return {
    runsDir, intentsDir, aiRoutingIdentity: aiExecutor.id,
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
        aiRoutingIdentity: context.aiRoutingIdentity, aiExecutor, codeExecutor: createCodeExecutor(context.workdir) }) };
    },
  };
};
