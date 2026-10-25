#!/usr/bin/env node
import * as path from 'path';
import { WorktreePool } from './worktree-pool';

const [action, brainDir, poolDir, slot, sessionId] = process.argv.slice(2);
const usage = `intentorch-worktrees <inspect|initialize|claim|archive-retained|recover-archive> <brainDir> <poolDir> [slot] [sessionId]
All paths are explicit. claim requires a verified saved-session owner.
archive-retained preserves files in an archive; stop any old executor before moving its workspace.
Existing locks are never automatically removed.`;
try {
  if (action === '--help' || action === '-h') console.log(usage);
  else {
    if (!brainDir || !poolDir) throw new Error(usage);
    const pool = new WorktreePool({ brainDir, poolDir });
    switch (action) {
      case 'inspect': console.log(JSON.stringify(pool.snapshot(), null, 2)); break;
      case 'initialize': pool.initialize(); console.log(JSON.stringify(pool.snapshot(), null, 2)); break;
      case 'claim':
        if (!slot || !sessionId || !/^ws-\d+$/.test(slot)) throw new Error('claim requires a slot and session ID');
        pool.claimRetained(path.join(poolDir, slot), sessionId); console.log(JSON.stringify(pool.snapshot(), null, 2)); break;
      case 'archive-retained':
        if (!slot) throw new Error('archive-retained requires a slot');
        console.log(pool.archiveRetained(slot)); break;
      case 'recover-archive':
        if (!slot) throw new Error('recover-archive requires a slot');
        console.log(pool.recoverArchival(slot)); break;
      default: throw new Error(usage);
    }
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
