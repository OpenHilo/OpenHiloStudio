const fs = require('node:fs');
const path = require('node:path');
const { createLocalDeployment } = require('@openhilo/server/local-deployment');
const { createWorkerLaunch } = require('@openhilo/server/worker-launch');
const { createConfigurationService } = require('@openhilo/platform-services/configuration-service');
const { git } = require('@openhilo/platform-services/publication');
const { createOfflineExecutor, identity } = require('./ai.cjs');

function initializeDemo(home) {
  if (!path.isAbsolute(home) || !fs.existsSync(home) || fs.readdirSync(home).length)
    throw new Error('Initialize requires an existing empty absolute demo directory');
  const brain = path.join(home, 'brain');
  fs.mkdirSync(brain);
  git(brain, ['init', '-b', 'main']);
  git(brain, ['config', 'user.name', 'OpenHilo Offline Demo']);
  git(brain, ['config', 'user.email', 'offline-demo@localhost']);
  fs.writeFileSync(
    path.join(brain, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'commonjs',
          strict: true,
          noEmit: true,
          types: [],
          skipLibCheck: true,
        },
        include: ['**/*.ts'],
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(brain, 'sys-globals.d.ts'),
    'declare function createEntity_by_sys(className: string, name: string, initData: object, desc: string, tags: object): Promise<{ id: string; created: boolean }>;\n'
  );
  fs.writeFileSync(path.join(brain, 'keep.ts'), 'export const demoVersion = 1;\n');
  git(brain, ['add', '.']);
  git(brain, ['commit', '-m', 'Initialize offline demo']);
  fs.writeFileSync(path.join(home, 'demo.json'), JSON.stringify({ version: 1, aiExecutorId: identity }));
}

async function openDemo(home) {
  if (!path.isAbsolute(home)) throw new Error('Demo home must be absolute');
  const marker = JSON.parse(fs.readFileSync(path.join(home, 'demo.json'), 'utf8'));
  if (marker.version !== 1 || marker.aiExecutorId !== identity) throw new Error('Incompatible demo deployment');
  const timers = new Set();
  const clock = {
    validate: cron => cron === '* * * * *',
    schedule(_cron, callback) { timers.add(callback); return { stop() { timers.delete(callback); } }; },
  };
  const executor = createOfflineExecutor();
  const host = await createLocalDeployment({
    home, aiExecutor: executor, clock,
    launch: createWorkerLaunch({ compositionModule: path.join(__dirname, 'worker.cjs'), env: { INTENTORCH_DEMO_HOME: home } }),
    generation: { maxClarificationRounds: 2, maxFeedbackRounds: 3, poolSize: 1, host: () => ({}) },
    configuration: createConfigurationService({ load: () => ({}), save: () => ({}), fields: {} }),
  });
  await host.startSchedules();
  return { ...host, executor,
    tick: () => { for (const callback of timers) callback(); },
    drainSchedules: () => host.scheduler.drain(),
  };
}
module.exports = { initializeDemo, openDemo };
