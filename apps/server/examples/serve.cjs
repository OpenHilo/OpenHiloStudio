// Deployment launcher: the caller supplies a module exporting async createOptions().
// That module owns data paths, worker processes, AI implementations and cleanup.
const path = require('node:path');
const { createServer } = require('@openhilo/server');

async function serve(createOptions, { host = '127.0.0.1', port = 3000 } = {}) {
  const app = await createServer(await createOptions());
  try { await app.listen({ host, port }); }
  catch (error) { await app.close(); throw error; }
  return app;
}
module.exports = { serve };

if (require.main === module) {
  (async () => {
    const modulePath = process.argv[2];
    if (!modulePath || !path.isAbsolute(modulePath)) throw new Error('Usage: node serve.cjs /absolute/path/to/host.cjs');
    const { createOptions } = require(modulePath);
    if (typeof createOptions !== 'function') throw new Error('The host module must export createOptions()');
    const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
    const app = await serve(createOptions, { host: process.env.INTENTORCH_HOST ?? '127.0.0.1', port });
    console.log(`OpenHilo listening at ${app.server.address().address}:${app.server.address().port}`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try { await app.close(); } catch (error) { console.error(error); process.exitCode = 1; }
    };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
