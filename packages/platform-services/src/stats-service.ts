import * as fs from 'fs';
import * as path from 'path';
import type { PlatformRunJson } from './run-history';

export interface DashboardStats {
  totalRuns: number;
  runningRuns: number;
  completedToday: number;
  failedRuns: number;
  pendingHumanNodes: number;
}

function collectAllRuns(dir: string): PlatformRunJson[] {
  const runs: PlatformRunJson[] = [];
  if (!fs.existsSync(dir)) return runs;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      runs.push(...collectAllRuns(full));
    } else if (entry.name === 'run.json') {
      try {
        const value: unknown = JSON.parse(fs.readFileSync(full, 'utf-8'));
        if (value && typeof value === 'object' && !Array.isArray(value)) runs.push(value as PlatformRunJson);
      } catch { /* skip unreadable records */ }
    }
  }
  return runs;
}

export async function getStats(runsDir: string, activeRunIds?: Set<string>): Promise<DashboardStats> {
  const runs = collectAllRuns(runsDir);
  const today = new Date().toISOString().slice(0, 10);
  return {
    totalRuns: runs.length,
    runningRuns: runs.filter(r => r.status === 'running' && (!activeRunIds || activeRunIds.has(r.run_id))).length,
    completedToday: runs.filter(r => r.status === 'completed' && typeof r.updated_at === 'string' && r.updated_at.startsWith(today)).length,
    failedRuns: runs.filter(r => r.status === 'failed').length,
    pendingHumanNodes: runs.filter(r => r.status === 'suspended').length,
  };
}
