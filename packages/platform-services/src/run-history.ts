import type { RunInputEncoding } from '@openhilo/itt-contracts/run-inputs';
import * as fs from 'fs';
import * as path from 'path';
import type { RunJson, RunStatus } from '@openhilo/runtime-contracts';
export interface PlatformRunJson extends RunJson {
  ittPath?: string;
  inputs?: Record<string, string>;
  inputEncoding?: RunInputEncoding;
  triggeredBy?: 'manual' | 'schedule';
  orphaned?: boolean;
}
export interface FilterConditions {
  intent?: string; status?: RunStatus; workdir?: string; createdAfter?: string; createdBefore?: string; completedOn?: string;
}

export interface ListRunsOpts {
  runsDir: string;
  filters?: FilterConditions;
  page?: number;
  limit?: number;
}

export interface ListRunsResult {
  runs: PlatformRunJson[];
  total: number;
  page: number;
  limit: number;
  unreadable?: { path: string; error: string }[];
}

function collectRunJsonPaths(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRunJsonPaths(full));
    } else if (entry.name === 'run.json') {
      results.push(full);
    }
  }
  return results;
}

function applyFilters(run: PlatformRunJson, f: FilterConditions): boolean {
  if (f.intent && run.intent !== f.intent) {
    // Library choices are namespace-qualified; older receipts retain the entry name.
    const separator = f.intent.lastIndexOf('.');
    const namespace = f.intent.slice(0, separator).split('.').join('/'), entry = f.intent.slice(separator + 1);
    const source = run.ittPath?.replace(/\\/g, '/');
    if (separator < 1 || !source ||
      ![`${namespace}/${entry}/${entry}.itt.impl.json`, `${namespace}/${entry}/${entry}.itt.json`,
        `${namespace}/${entry}.itt.impl.json`, `${namespace}/${entry}.itt.json`]
        .some(suffix => source === suffix || source.endsWith(`/${suffix}`))) return false;
  }
  if (f.completedOn && (run.status !== 'completed' || typeof run.updated_at !== 'string' || !run.updated_at.startsWith(f.completedOn))) return false;
  if (f.status && run.status !== f.status) return false;
  if (f.workdir && !run.workdir.startsWith(f.workdir)) return false;
  if (f.createdAfter && Date.parse(run.created_at) < Date.parse(f.createdAfter)) return false;
  if (f.createdBefore && Date.parse(run.created_at) > Date.parse(f.createdBefore)) return false;
  return true;
}

export async function listRuns(opts: ListRunsOpts): Promise<ListRunsResult> {
  const { runsDir, filters = {}, page = 1, limit = 20 } = opts;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(page * limit)) {
    throw Object.assign(new Error('page and limit must be positive integers within the safe pagination range'), { statusCode: 400 });
  }
  if (filters.status && !['running', 'completed', 'failed', 'aborted', 'suspended'].includes(filters.status)) {
    throw Object.assign(new Error(`Invalid status filter: ${filters.status}. Choose a listed status or All statuses.`), { statusCode: 400 });
  }
  for (const key of ['createdAfter', 'createdBefore'] as const) {
    if (filters[key] && !Number.isFinite(Date.parse(filters[key]))) {
      throw Object.assign(new Error(`Invalid ${key} filter: use a valid date or remove the filter.`), { statusCode: 400 });
    }
  }
  if (filters.createdAfter && filters.createdBefore && Date.parse(filters.createdAfter) > Date.parse(filters.createdBefore)) {
    throw Object.assign(new Error('Invalid date filters: createdAfter must not be later than createdBefore.'), { statusCode: 400 });
  }
  if (filters.completedOn && (!/^\d{4}-\d{2}-\d{2}$/.test(filters.completedOn) || !Number.isFinite(Date.parse(filters.completedOn)) || new Date(filters.completedOn).toISOString().slice(0,10)!==filters.completedOn)) throw Object.assign(new Error('Invalid completion date: use YYYY-MM-DD (UTC).'), {statusCode:400});
  const jsonPaths = collectRunJsonPaths(runsDir);

  const runs: PlatformRunJson[] = [];
  const unreadable: { path: string; error: string }[] = [];
  for (const p of jsonPaths) {
    try {
      const run = JSON.parse(fs.readFileSync(p, 'utf-8')) as PlatformRunJson;
      if (!run || typeof run.run_id !== 'string' || typeof run.intent !== 'string' || typeof run.workdir !== 'string' ||
          typeof run.created_at !== 'string' || typeof run.status !== 'string') throw new Error('Missing or invalid run metadata');
      if (applyFilters(run, filters)) runs.push(run);
    } catch (error) {
      unreadable.push({ path: path.relative(runsDir, p), error: error instanceof SyntaxError ? 'Invalid JSON in run metadata' : error instanceof Error ? error.message : 'Cannot read run metadata' });
    }
  }

  runs.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const total = runs.length;
  const start = (page - 1) * limit;
  return { runs: runs.slice(start, start + limit), total, page, limit, ...(unreadable.length ? { unreadable } : {}) };
}

export async function findRunDir(runId: string, runsDir: string): Promise<string | null> {
  const jsonPaths = collectRunJsonPaths(runsDir);
  for (const p of jsonPaths) {
    try {
      const run = JSON.parse(fs.readFileSync(p, 'utf-8')) as { run_id: string };
      if (run.run_id === runId) return path.dirname(p);
    } catch {
      // skip
    }
  }
  return null;
}
