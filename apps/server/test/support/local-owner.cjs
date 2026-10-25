const { createLocalDeployment } = require('@openhilo/server/local-deployment');
async function openOwner() { return createLocalDeployment({
  home: process.argv[2],
  aiExecutor: { id: 'owner-test', capabilities: [], start() { throw Error('No AI expected'); } },
  launch() { throw Error('No worker expected'); },
  clock: { validate: () => true, schedule() { throw Error('No timer expected'); } },
  configuration: { read: () => ({}), update: value => value },
}); }
async function abandonFailedOwner() {
  const host = await openOwner();
  host.workers.close = async () => { throw Error('Drain failed'); };
  await require('node:assert/strict').rejects(host.close(), /did not drain all work/);
}
async function main() {
  if (process.argv[3] === 'failed-drain-gc') {
    await abandonFailedOwner();
    // Let the rejected shutdown and its deployment leave the stack, then run
    // repeated full collections before the parent tries to claim the home.
    for (let i = 0; i < 20; i++) { await new Promise(setImmediate); global.gc(); }
    process.on('message', () => {});
    process.send('ready');
    return;
  }
  const host = await openOwner();
  process.on('message', async message => { if (message === 'close') { await host.close(); process.disconnect(); } });
  process.send('ready');
}
main().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
