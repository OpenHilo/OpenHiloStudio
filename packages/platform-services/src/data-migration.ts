import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

export interface MigrationEntry { kind: 'file' | 'directory'; mode: number; size?: number; sha256?: string }
export type MigrationInventory = Record<string, MigrationEntry>;
export interface MigrationStep {
  /** Stable migration identity; domain and generic storage use different IDs/versions. */
  id: string;
  version: number;
  /** Trusted migration code. Only this working copy is an authorized mutation target. */
  apply(dataDir: string): void | Promise<void>;
}
export interface MigrationReport {
  version: 1;
  activation: 'not_activated';
  sourceDir: string;
  status: 'copying' | 'migrating' | 'completed' | 'failed';
  backupComplete: boolean;
  original: MigrationInventory;
  steps: Array<{ id: string; version: number; status: 'pending' | 'running' | 'completed' | 'failed'; added?: string[]; removed?: string[]; changed?: string[] }>;
  failure?: { code: string; message: string };
}
export class DataMigrationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DataMigrationError'; }
}
const fail = (code: string, message: string): never => { throw new DataMigrationError(code, message); };

/** No symlink traversal, sockets or device files. Offline ordinary directory trees only. */
function inventory(root: string): MigrationInventory {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('unsupported_entry', 'Backup/data roots must be ordinary directories');
  const result: MigrationInventory = Object.create(null);
  function visit(directory: string, prefix: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('unsupported_entry', `Offline copy cannot include a symlink or special entry: ${relative}`);
      if (stat.isDirectory()) {
        result[relative] = { kind: 'directory', mode: stat.mode & 0o777 };
        visit(absolute, relative);
      } else {
        result[relative] = { kind: 'file', mode: stat.mode & 0o777, size: stat.size, sha256: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') };
      }
    }
  }
  visit(root, '');
  return result;
}
function same(a: MigrationInventory, b: MigrationInventory): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function rootDirectory(value: string): string {
  if (!path.isAbsolute(value)) fail('invalid_path', 'Migration paths must be explicit absolute paths');
  const root = fs.realpathSync(value);
  if (!fs.statSync(root).isDirectory()) fail('invalid_path', 'Migration source must be a directory');
  return root;
}
function newDirectory(value: string, outside: string): string {
  if (!path.isAbsolute(value)) fail('invalid_path', 'Migration paths must be explicit absolute paths');
  const destination = path.join(rootDirectory(path.dirname(value)), path.basename(value));
  const relative = path.relative(outside, destination);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail('nested_destination', 'Migration destination must be outside the source tree');
  if (existsEntry(destination)) fail('destination_exists', 'Migration destination must not already exist');
  return destination;
}
function existsEntry(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function copyTree(source: string, destination: string, expected: MigrationInventory): void {
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const [relative, entry] of Object.entries(expected)) {
    const from = path.join(source, relative), to = path.join(destination, relative);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink() || (entry.kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) fail('source_changed', 'Source changed while copying; do not use this migration');
    if (entry.kind === 'directory') fs.mkdirSync(to, { mode: 0o700 });
    else { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, entry.mode); }
  }
  // Preserve restrictive directory modes only after populating descendants.
  for (const [relative, entry] of Object.entries(expected).reverse()) if (entry.kind === 'directory') fs.chmodSync(path.join(destination, relative), entry.mode);
  if (!same(expected, inventory(destination))) fail('copy_mismatch', 'Copied files do not match the source inventory');
}
function writeReport(bundleDir: string, report: MigrationReport): void {
  const temporary = path.join(bundleDir, `.report-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(bundleDir, 'report.json'));
  } finally { fs.rmSync(temporary, { force: true }); }
}
function difference(before: MigrationInventory, after: MigrationInventory) {
  return {
    added: Object.keys(after).filter(key => !Object.hasOwn(before, key)),
    removed: Object.keys(before).filter(key => !Object.hasOwn(after, key)),
    changed: Object.keys(after).filter(key => Object.hasOwn(before, key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])),
  };
}

/** Creates backup/ and data/ under a fresh private bundle; never activates or mutates the source.
 * Stop all source writers first. Hash comparisons detect observed changes, not concurrent snapshot isolation.
 * Steps are trusted code, not sandboxed; arbitrary process-crash resumption is deliberately unsupported.
 */
export async function migrateDataCopy(options: { sourceDir: string; bundleDir: string; steps: readonly MigrationStep[] }): Promise<MigrationReport> {
  const sourceDir = rootDirectory(options.sourceDir), bundleDir = newDirectory(options.bundleDir, sourceDir);
  const ids = new Set<string>();
  for (const step of options.steps) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(step.id) || !Number.isSafeInteger(step.version) || step.version < 1 || ids.has(step.id)) fail('invalid_step', 'Migration steps require unique stable IDs and positive integer versions');
    ids.add(step.id);
  }
  fs.mkdirSync(bundleDir, { mode: 0o700 });
  const report: MigrationReport = { version: 1, activation: 'not_activated', sourceDir, status: 'copying', backupComplete: false, original: {},
    steps: options.steps.map(step => ({ id: step.id, version: step.version, status: 'pending' })) };
  const backup = path.join(bundleDir, 'backup'), data = path.join(bundleDir, 'data');
  try {
    writeReport(bundleDir, report);
    report.original = inventory(sourceDir);
    copyTree(sourceDir, backup, report.original);
    if (!same(report.original, inventory(sourceDir))) fail('source_changed', 'Source changed during backup; stop all writers before retrying');
    report.backupComplete = true;
    writeReport(bundleDir, report);
    copyTree(backup, data, report.original);
    report.status = 'migrating';
    for (const [index, step] of options.steps.entries()) {
      const before = inventory(data), receipt = report.steps[index];
      receipt.status = 'running'; writeReport(bundleDir, report);
      try {
        await step.apply(data);
        Object.assign(receipt, difference(before, inventory(data)), { status: 'completed' });
      } catch {
        receipt.status = 'failed';
        // Migration exceptions may contain config/database values; never copy them into the report.
        fail('step_failed', `Migration step ${step.id} failed; inspect the working copy and restore the backup to a new directory`);
      }
      writeReport(bundleDir, report);
    }
    if (!same(report.original, inventory(backup))) fail('backup_changed', 'Backup changed during migration; it must not be used for recovery');
    if (!same(report.original, inventory(sourceDir))) fail('source_changed', 'Source changed during migration; the working copy is not current');
    report.status = 'completed'; writeReport(bundleDir, report);
    return report;
  } catch (error) {
    report.status = 'failed';
    report.failure = error instanceof DataMigrationError ? { code: error.code, message: error.message } : { code: 'io_failed', message: 'Migration I/O failed; original data was not activated or replaced' };
    writeReport(bundleDir, report);
    throw new DataMigrationError(report.failure.code, report.failure.message);
  }
}

/** Verify a complete backup against its persisted inventory and restore into a fresh directory. */
export function restoreMigrationBackup(bundlePath: string, destinationPath: string): void {
  const bundleDir = rootDirectory(bundlePath), destination = newDirectory(destinationPath, bundleDir);
  const report = JSON.parse(fs.readFileSync(path.join(bundleDir, 'report.json'), 'utf8')) as MigrationReport;
  if (report.version !== 1 || report.backupComplete !== true || !report.original || typeof report.original !== 'object' || Array.isArray(report.original)) fail('invalid_backup', 'Bundle has no verified complete backup');
  if (typeof report.sourceDir !== 'string' || !path.isAbsolute(report.sourceDir)) fail('invalid_backup', 'Backup has no absolute source identity');
  newDirectory(destination, report.sourceDir);
  const backup = path.join(bundleDir, 'backup');
  // Use a fresh filesystem inventory for copying; persisted paths are never used as copy instructions.
  const actual = inventory(backup);
  if (!same(report.original, actual)) fail('backup_changed', 'Backup does not match the recorded inventory');
  copyTree(backup, destination, actual);
  if (!same(actual, inventory(backup))) fail('backup_changed', 'Backup changed during restoration');
}


/** The historical dotted-directory conversion, planned without modifying any source files. */
export function planBrainDirectoryMigration(sourcePath: string): Array<{ from: string; to: string }> {
  const source = rootDirectory(sourcePath);
  inventory(source); // Reject links/special files before traversing legacy buckets.
  const changes: Array<{ from: string; to: string }> = [];
  for (const bucket of ['dev', 'shared']) {
    const directory = path.join(source, 'intents', bucket);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).sort()) {
      if (name.startsWith('.') || !name.includes('.') || !fs.lstatSync(path.join(directory, name)).isDirectory()) continue;
      const parts = name.split('.');
      if (parts.some(part => !part)) fail('invalid_namespace', 'Dotted namespace contains an empty path segment');
      const from = `intents/${bucket}/${name}`, to = `intents/${bucket}/${parts.join('/')}`;
      if (existsEntry(path.join(source, to))) fail('namespace_conflict', `Namespace destination already exists: ${to}`);
      changes.push({ from, to });
    }
  }
  return changes.sort((a, b) => a.to.split('/').length - b.to.split('/').length || a.from.localeCompare(b.from));
}

export function migrateBrainDirectoriesCopy(options: { sourceDir: string; bundleDir: string }): Promise<MigrationReport> {
  return migrateDataCopy({ ...options, steps: [{ id: 'platform.brain-namespace-layout', version: 1,
    apply(dataDir) {
      for (const change of planBrainDirectoryMigration(dataDir)) {
        const target = path.join(dataDir, change.to);
        if (existsEntry(target)) fail('namespace_conflict', `Namespace destination already exists: ${change.to}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(path.join(dataDir, change.from), target);
      }
    },
  }] });
}
