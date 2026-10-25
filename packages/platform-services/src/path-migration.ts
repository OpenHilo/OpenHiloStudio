import * as fs from 'fs';
import { decodeCheckpointStack, encodeStateGraph } from '@openhilo/runtime/state-graph';
import type { Value } from '@openhilo/itt-contracts';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { inspectMigrationSource, type MigrationInspection } from './migration-inspection';
import { migrateDataCopy, type MigrationReport } from './data-migration';

export interface PathMapping { from: string; to: string }
export interface PathRebindingPlan {
  version: 1;
  sourceDir: string;
  bundleDir: string;
  /** Explicit extra prefix mappings. Longest matching prefix wins; no external data is copied. */
  mappings: PathMapping[];
  files: Array<{ file: string; sha256: string; edits: Array<{
    keys: Array<string | number>; record: 'json' | 'final_checkpoint'; from: string; to: string;
  }> }>;
  unresolved: MigrationInspection['paths'];
  review: MigrationInspection['issues'];
  activation: 'not_checked';
}
const inside = (root: string, value: string) => {
  const relative = path.relative(root, value);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function absolute(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Path migration requires explicit absolute paths');
  return path.resolve(value);
}
function destination(sourceDir: string, bundle: string): string {
  const requested = absolute(bundle);
  const result = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  if (inside(sourceDir, result)) throw new Error('Path migration bundle must be outside the source');
  try { fs.lstatSync(result); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
  throw new Error('Path migration bundle must not exist');
}

/** Plans known metadata fields only. No arbitrary object walk, historical-event rewrite or Git operation. */
export function planPathRebinding(options: { sourceDir: string; bundleDir: string; mappings?: readonly PathMapping[] }): PathRebindingPlan {
  const sourceDir = absolute(options.sourceDir), realSource = fs.realpathSync(sourceDir);
  const bundleDir = destination(realSource, options.bundleDir), target = path.join(bundleDir, 'data');
  const inspection = inspectMigrationSource({ sourceDir });
  if (!inspection.scanComplete) throw new Error('Path migration requires a complete metadata inspection');
  if (inspection.runs.some(run => run.humanCheckpoint === 'missing_or_invalid')) throw new Error('Path migration requires valid human checkpoint candidates for suspended runs');
  if (options.mappings !== undefined && !Array.isArray(options.mappings)) throw new Error('Path mappings must be an array');
  const mappings = (options.mappings ?? []).map(item => {
    if (!item || typeof item !== 'object') throw new Error('Path mappings require source and destination paths');
    return { from: absolute(item.from), to: absolute(item.to) };
  });
  const prefixes = new Set<string>();
  for (const item of mappings) {
    if (prefixes.has(item.from)) throw new Error('Path migration mappings must have unique source prefixes');
    prefixes.add(item.from);
    if (inside(realSource, item.from) || inside(sourceDir, item.from) || inside(item.from, realSource) || inside(item.from, sourceDir)) throw new Error('Extra mappings must not overlap the migration source');
  }
  const bindings = [...mappings, { from: sourceDir, to: target }, ...(realSource === sourceDir ? [] : [{ from: realSource, to: target }])].sort((a, b) => b.from.length - a.from.length);
  const grouped = new Map<string, PathRebindingPlan['files'][number]>();
  const unresolved: MigrationInspection['paths'] = [];
  for (const reference of inspection.paths) {
    if (reference.location === 'relative') { unresolved.push(reference); continue; }
    const mapping = bindings.find(item => inside(item.from, reference.value));
    if (!reference.keys || !reference.record || !mapping) { unresolved.push(reference); continue; }
    const to = path.join(mapping.to, path.relative(mapping.from, reference.value));
    if (to === reference.value) continue;
    let file = grouped.get(reference.file);
    if (!file) {
      file = { file: reference.file, sha256: hash(fs.readFileSync(path.join(realSource, reference.file))), edits: [] };
      grouped.set(reference.file, file);
    }
    file.edits.push({ keys: reference.keys, record: reference.record, from: reference.value, to });
  }
  return { version: 1, sourceDir, bundleDir, mappings, files: [...grouped.values()], unresolved, review: inspection.issues, activation: 'not_checked' };
}

function replace(root: unknown, edit: PathRebindingPlan['files'][number]['edits'][number]): void {
  let parent = root;
  for (const key of edit.keys.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('Path migration field is missing');
    parent = (parent as Record<string | number, unknown>)[key];
  }
  const key = edit.keys.at(-1)!;
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key) || (parent as Record<string | number, unknown>)[key] !== edit.from) throw new Error('Path migration field changed');
  // Existing own properties only; defineProperty avoids prototype setter semantics.
  Object.defineProperty(parent, key, { value: edit.to, enumerable: true, configurable: true, writable: true });
}
function applyPlan(dataDir: string, plan: PathRebindingPlan): void {
  if (dataDir !== path.join(plan.bundleDir, 'data')) throw new Error('Path plan destination mismatch');
  for (const file of plan.files) {
    const target = path.join(dataDir, file.file), original = fs.readFileSync(target);
    if (hash(original) !== file.sha256) throw new Error('Path migration file changed since planning');
    const isLog = file.edits[0].record === 'final_checkpoint';
    let prefix = '', suffix = '', document: unknown, graphCheckpoint = false;
    if (isLog) {
      // Keep every earlier byte (including line endings) and trailing whitespace.
      const content = original.toString('utf8'), trimmed = content.trimEnd();
      const boundary = trimmed.lastIndexOf('\n') + 1;
      prefix = content.slice(0, boundary); suffix = content.slice(trimmed.length);
      document = JSON.parse(trimmed.slice(boundary));
      const checkpoint = document as { call_stack: unknown };
      graphCheckpoint = !Array.isArray(checkpoint.call_stack);
      checkpoint.call_stack = decodeCheckpointStack(checkpoint.call_stack);
    } else document = JSON.parse(original.toString('utf8'));
    for (const edit of file.edits) replace(document, edit);
    if (graphCheckpoint) {
      const checkpoint = document as { call_stack: Value };
      checkpoint.call_stack = encodeStateGraph(checkpoint.call_stack) as unknown as Value;
    }
    const output = isLog ? prefix + JSON.stringify(document) + suffix : JSON.stringify(document, null, 2) + '\n';
    const temporary = path.join(path.dirname(target), `.path-migration-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, output, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(temporary, fs.statSync(target).mode & 0o777);
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}

/** Revalidate a reviewed plan, then apply only inside a new backed-up working copy. */
export async function migratePathsCopy(options: { plan: PathRebindingPlan; bundleDir: string }): Promise<MigrationReport> {
  const plan = options.plan;
  if (!plan || plan.version !== 1 || !Array.isArray(plan.mappings)) throw new Error('Unsupported path migration plan');
  const current = planPathRebinding({ sourceDir: plan.sourceDir, bundleDir: options.bundleDir, mappings: plan.mappings });
  if (!isDeepStrictEqual(plan, current)) throw new Error('Path migration plan is stale or altered; inspect and generate a new plan');
  return migrateDataCopy({ sourceDir: plan.sourceDir, bundleDir: current.bundleDir, steps: [
    { id: 'platform.known-path-bindings', version: 1, apply: dataDir => applyPlan(dataDir, current) },
  ] });
}
