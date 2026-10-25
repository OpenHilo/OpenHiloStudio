const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const cron = require('node-cron');
const { createWorkerLaunch } = require('@openhilo/server/worker-launch');
const { createRoutingSettings } = require('./settings.cjs');
const { readSelection, readSavedSelection, createExecutor } = require('./config.cjs');
const { genericGenerationPolicy } = require('@openhilo/generation-contracts');

exports.createDeploymentOptions = ({ home }) => {
  const selection = readSelection(home);
  const aiExecutor = createExecutor(selection);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const configuration = createRoutingSettings(selection);
  return {
    aiExecutor, configuration,
    beforeResume({runDir}) {
      const saved = JSON.parse(fs.readFileSync(path.join(runDir,'run.json'),'utf8'));
      try {
        const original = readSavedSelection(home, saved.aiExecutorId);
        if (saved.ai_routing_identity !== createExecutor(original).id) throw new Error('Routing identity mismatch');
      } catch {
        throw Object.assign(new Error('Saved AI routing configuration is unavailable or changed. Restore its original revision before resuming.'), {statusCode:400});
      }
    },
    generation: {policy: {...genericGenerationPolicy,
      buildPrompt(input,state) {
        const aiRoutes = Object.fromEntries(Object.entries(selection.execution.routes).map(([type,g])=>[type,{defaultLevel:g.defaultLevel,levels:Object.keys(g.levels)}]));
        return genericGenerationPolicy.buildPrompt({...input,aiRoutes},state);
      }
    }},
    launch: createWorkerLaunch({ compositionModule: path.join(__dirname, 'worker.cjs'),
      env: { INTENTORCH_ROUTED_HOME: selection.home, INTENTORCH_ROUTED_IDENTITY: selection.identity } }),
    clock: {
      timeZone,
      validate: expression => cron.validate(expression),
      schedule(expression, callback) {
        const name = `intentorch-sdk-${randomUUID()}`;
        const task = cron.schedule(expression, callback, { name, timezone: timeZone });
        return { stop() { task.destroy(); }, getNextRun() { return task.getNextRun(); } };
      },
    },
  };
};
