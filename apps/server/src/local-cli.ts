#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { createLocalDeployment, type LocalDeploymentOptions } from './local-deployment';
import { initializeLocalHome } from './local-initialize';
import { startDeploymentProcess } from './deployment-process';

export type LocalCompositionFactory = (context: { home: string }) => Omit<LocalDeploymentOptions, 'home'> | Promise<Omit<LocalDeploymentOptions, 'home'>>;
/** Trusted deployment module. Importing this CLI never loads one or installs process listeners. */
export async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv, flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--home', '--config', '--composition', '--host', '--port', '--studio'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || flags.has(args[i])) throw new Error('Invalid or duplicate server option');
    flags.set(args[i], args[i + 1]);
  }
  const absolute = (name: string) => {
    const value = flags.get(name);
    if (!value || !path.isAbsolute(value)) throw new Error(`${name} requires an explicit absolute path`);
    return path.resolve(value);
  };
  if (command === 'init' && flags.size === 2 && flags.has('--home') && flags.has('--config')) {
    let configuration: unknown;
    try { configuration = JSON.parse(fs.readFileSync(absolute('--config'), 'utf8')); }
    catch { throw new Error('Could not read valid explicit deployment configuration'); }
    console.log(JSON.stringify(initializeLocalHome({ home: absolute('--home'), configuration })));
    return;
  }
  if (command !== 'start' || !flags.has('--home') || !flags.has('--composition') || flags.has('--config')) throw new Error('Usage: openhilo-server init --home NEW_ABS --config ABS | start --home ABS --composition ABS [--host ADDRESS] [--port NUMBER] [--studio ABS]');
  const home = fs.realpathSync(absolute('--home'));
  const receiptFile = path.join(home, 'deployment.json');
  if (fs.existsSync(receiptFile)) {
    let receipt: { version?: unknown; layout?: unknown; status?: unknown };
    try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); }
    catch { throw new Error('Local deployment initialization receipt is invalid'); }
    if (!receipt || receipt.version !== 1 || receipt.layout !== 'intentorch.local' || receipt.status !== 'ready') throw new Error('Local deployment initialization is not ready; inspect the retained directory');
  }
  const modulePath = fs.realpathSync(absolute('--composition'));
  const portValue = flags.get('--port') ?? '2000', hostAddress = flags.get('--host') ?? '127.0.0.1';
  if (!/^\d+$/.test(portValue) || !Number.isSafeInteger(Number(portValue)) || Number(portValue) > 65535) throw new Error('Port must be an integer between 0 and 65535');
  const publicDir = flags.has('--studio') ? absolute('--studio') : undefined;
  await startDeploymentProcess({
    host: hostAddress, port: Number(portValue),
    async create(isStopping) {
      const loaded = require(modulePath) as { createDeploymentOptions?: LocalCompositionFactory };
      if (typeof loaded.createDeploymentOptions !== 'function') throw new Error('Composition module must export createDeploymentOptions({home})');
      const options = await loaded.createDeploymentOptions({ home });
      if (isStopping()) return;
      return createLocalDeployment({ ...options, home, ...(publicDir ? { publicDir } : {}) });
    },
    onListening: address => { console.log(JSON.stringify({ status: 'listening', address, home })); },
  });
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : 'Server failed'); process.exitCode = 1; });
