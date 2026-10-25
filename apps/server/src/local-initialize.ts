import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { BRAIN_TSCONFIG, SYS_GLOBALS_DTS } from '@openhilo/platform-services/brain-template';
import { parseDeploymentConfig } from '@openhilo/platform-services/deployment-config';

/** Initialize a NEW explicit local home. Existing data is never repaired, replaced or removed. */
export function initializeLocalHome(options: { home: string; configuration: unknown }): { home: string; status: 'ready' } {
  if (!path.isAbsolute(options.home)) throw new Error('Initialization requires an explicit absolute home');
  const home = path.join(fs.realpathSync(path.dirname(options.home)), path.basename(options.home));
  const configuration = parseDeploymentConfig(options.configuration);
  // mkdir without recursive is also the no-overwrite guard, including dangling links.
  fs.mkdirSync(home, { mode: 0o700 });
  const receipt = path.join(home, 'deployment.json');
  const writeReceipt = (status: string) => fs.writeFileSync(receipt, JSON.stringify({ version: 1, layout: 'intentorch.local', status }) + '\n', { mode: 0o600 });
  try {
    writeReceipt('initializing');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(configuration, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    for (const directory of ['brain', 'intents', 'runs', 'sessions', 'pool', 'workspaces']) fs.mkdirSync(path.join(home, directory), { mode: 0o700 });
    for (const file of ['schedules.json', 'filters.json']) fs.writeFileSync(path.join(home, file), '[]\n', { mode: 0o600, flag: 'wx' });
    const brain = path.join(home, 'brain');
    fs.writeFileSync(path.join(brain, 'tsconfig.json'), BRAIN_TSCONFIG + '\n', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(brain, 'sys-globals.d.ts'), SYS_GLOBALS_DTS, { mode: 0o600, flag: 'wx' });
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: brain, encoding: 'utf8', stdio: 'pipe' });
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'OpenHilo']); git(['config', 'user.email', 'local@openhilo']);
    git(['add', '--', 'tsconfig.json', 'sys-globals.d.ts']);
    git(['commit', '-m', 'Initialize generic OpenHilo Brain']);
    writeReceipt('ready');
    return { home, status: 'ready' };
  } catch {
    try { writeReceipt('failed'); } catch { /* Preserve the original partial directory even if the receipt cannot be written. */ }
    throw new Error('Local initialization failed; the partial directory was retained for inspection. Choose a new directory to retry.');
  }
}
