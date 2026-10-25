const path = require('node:path');
const { randomUUID } = require('node:crypto');
const cron = require('node-cron');
const { createWorkerLaunch } = require('@openhilo/server/worker-launch');
const { ConfigurationInputError } = require('@openhilo/platform-services/configuration-service');
const { readSelection, createExecutor } = require('./config.cjs');

exports.createDeploymentOptions = ({ home }) => {
  const selection = readSelection(home);
  const aiExecutor = createExecutor(selection);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Configuration is a startup snapshot. Editing the file requires a restart;
  // existing workers continue their captured selection, new workers reject drift.
  const configuration = {
    read: () => structuredClone({ application: selection.application, ai_execution: selection.execution,
      configuration_status: { activation: 'restart', restart_required: readSelection(home).identity !== selection.identity, editable: false } }),
    update() { throw new ConfigurationInputError('Edit config.json and restart the Codex deployment to change its selection'); },
  };
  return {
    aiExecutor, configuration,
    launch: createWorkerLaunch({ compositionModule: path.join(__dirname, 'worker.cjs'),
      env: { INTENTORCH_Codex_HOME: selection.home, INTENTORCH_Codex_IDENTITY: selection.identity } }),
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
