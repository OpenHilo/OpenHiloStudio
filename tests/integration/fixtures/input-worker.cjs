const fs = require('node:fs'), path = require('node:path');
const { createDispatcher } = require('@openhilo/runtime/dispatcher');
const { createCodeExecutor } = require('@openhilo/code-local');
exports.createComposition = request => {
  const home = process.env.INTENTORCH_INPUT_FIXTURE_HOME;
  if (!home || !path.isAbsolute(home)) throw new Error('Explicit fixture home required');
  return {
    runsDir: path.join(home, 'runs'), intentsDir: path.join(home, 'intents'),
    populateSnapshot({ snapshotDir }) {
      const entry = path.join(home, 'intents', request.input.ittPath);
      fs.copyFileSync(entry, path.join(snapshotDir, path.basename(entry)));
    },
    createResources(context, ports) { return { executor: createDispatcher({ ...ports, runId: context.runId,
      workdir: context.workdir, codeExecutor: createCodeExecutor(context.workdir) }) }; },
  };
};
