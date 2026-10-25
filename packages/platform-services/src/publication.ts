import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

export interface PublicationCandidate {
  version: 1;
  id: string;
  reviewId: string;
  worktree: string;
  brainDir: string;
  intentsDir: string;
  baseRevision: string;
  inputDigest: string;
  targetDigest: string;
  sources: Record<string, string>;
  artifacts: Record<string, string>;
}
export function git(directory: string, args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: 'pipe' });
}
export function digest(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical)
    : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : entry;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function safeFile(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw new Error(`Invalid publication path: ${relative}`);
  const file = path.join(root, relative);
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Publication path must not be a symlink: ${relative}`);
  }
  return file;
}
/** Text tree for the existing ITT publication layout. Reject links rather than following them. */
export function readArtifactTree(root: string): Record<string, string> {
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('Artifact root must not be a symlink');
  const entries: [string, string][] = [];
  function scan(dir: string, prefix: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir).sort()) {
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const file = safeFile(root, relative);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) scan(file, relative);
      else if (stat.isFile()) entries.push([relative, fs.readFileSync(file).toString('base64')]);
      else throw new Error(`Unsupported artifact file: ${relative}`);
    }
  }
  scan(root, '');
  return Object.fromEntries(entries);
}
export function readCompilationInputs(worktree: string): Record<string, string> {
  const files = new Set(git(worktree, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  return Object.fromEntries([...files].sort().filter(file => file.endsWith('.ts') || path.basename(file) === 'tsconfig.json').map(file => {
    const absolute = safeFile(worktree, file);
    return [file, fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '<deleted>'];
  }));
}
function candidateId(candidate: Omit<PublicationCandidate, 'id'>): string { return digest(candidate); }
export function prepareCandidate(options: Omit<PublicationCandidate, 'version' | 'id' | 'reviewId' | 'inputDigest' | 'targetDigest' | 'baseRevision'>): PublicationCandidate {
  const candidate = { ...options, version: 1 as const, reviewId: crypto.randomUUID(), baseRevision: git(options.brainDir, ['rev-parse', 'HEAD']).trim(),
    inputDigest: digest(readCompilationInputs(options.worktree)), targetDigest: digest(readArtifactTree(options.intentsDir)) };
  return { ...candidate, id: candidateId(candidate) };
}
export function verifyCandidate(candidate: PublicationCandidate): void {
  const { id, ...content } = candidate;
  if (candidate.version !== 1 || id !== candidateId(content)) throw new Error('Invalid publication receipt; run preflight and review again');
  if (digest(readCompilationInputs(candidate.worktree)) !== candidate.inputDigest) throw new Error('Candidate source changed after review; run preflight and review again');
  if (git(candidate.brainDir, ['rev-parse', 'HEAD']).trim() !== candidate.baseRevision) throw new Error('Publication base changed; run preflight and review again');
  if (git(candidate.brainDir, ['status', '--porcelain', '--untracked-files=all']).trim()) throw new Error('Brain has local changes; publication preserves them and requires a clean target');
  if (digest(readArtifactTree(candidate.intentsDir)) !== candidate.targetDigest) throw new Error('Installed artifacts changed; run preflight and review again');
  const changed = git(candidate.worktree, ['diff', candidate.baseRevision, '--name-only', '-z']).split('\0').filter(Boolean);
  if (changed.some(file => !Object.hasOwn(candidate.sources, file))) throw new Error('Candidate includes unreviewed tracked changes');
  for (const [file, source] of Object.entries(candidate.sources)) {
    if (fs.readFileSync(safeFile(candidate.worktree, file), 'utf8') !== source) throw new Error('Reviewed source content no longer matches');
  }
  if (git(candidate.worktree, ['merge-base', candidate.baseRevision, 'HEAD']).trim() !== candidate.baseRevision) throw new Error('Candidate is based on an older target; synchronize and review again');
}
/**
 * Stage every artifact before source publication, preserving the previous tree and
 * a journal. A failed activation keeps the lock/journal for explicit recovery.
 * This is a local single-publisher protocol, not a multi-reader filesystem transaction.
 */
export function publishCandidate(candidate: PublicationCandidate, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(candidate.id)) throw new Error('Invalid publication candidate ID');
  const parent = path.dirname(candidate.intentsDir);
  fs.mkdirSync(parent, { recursive: true });
  const lock = path.join(parent, '.intentorch-publication-lock');
  try { fs.mkdirSync(lock); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error(`Publication locked or interrupted; inspect ${lock}`);
    throw new Error(`Cannot start publication: unable to create its lock at ${lock} (${code ?? 'write error'}). Check write permissions and available disk space. Nothing was published.`);
  }
  let transactionCreated = false;
  let sourceCommitted = false;
  let sourceMutationStarted = false;
  let preparedRevision: string | undefined;
  const transaction = path.join(parent, '.intentorch-publications', candidate.id);
  const stage = path.join(transaction, 'artifacts');
  const backup = path.join(transaction, 'previous-artifacts');
  const journal = (phase: string, error?: string) => {
    const record = { version: 1, candidateId: candidate.id, phase, brainDir: candidate.brainDir, intentsDir: candidate.intentsDir,
      baseRevision: candidate.baseRevision, preparedRevision, stage, backup, ...(sourceCommitted ? { sourceRevision: git(candidate.brainDir, ['rev-parse', 'HEAD']).trim() } : {}), ...(error ? { error } : {}) };
    fs.writeFileSync(path.join(transaction, 'journal.tmp'), JSON.stringify(record, null, 2));
    fs.renameSync(path.join(transaction, 'journal.tmp'), path.join(transaction, 'journal.json'));
  };
  try {
    verifyCandidate(candidate);
    if (fs.existsSync(transaction)) throw new Error('Publication receipt already has a transaction; inspect its journal');
    fs.mkdirSync(stage, { recursive: true });
    transactionCreated = true;
    fs.writeFileSync(path.join(lock, 'transaction.json'), JSON.stringify({ transaction, candidateId: candidate.id }));
    fs.writeFileSync(path.join(transaction, 'candidate.json'), JSON.stringify(candidate, null, 2));
    for (const [file, content] of Object.entries(candidate.artifacts)) {
      const destination = safeFile(stage, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, Buffer.from(content, 'base64'));
    }
    journal('prepared');
    const files = Object.keys(candidate.sources);
    // Commit only the reviewed source paths; unrelated staged files are never included.
    if (files.length) {
      git(candidate.worktree, ['add', '--', ...files]);
      if (git(candidate.worktree, ['diff', '--cached', '--name-only', '--', ...files]).trim()) {
        git(candidate.worktree, ['-c', 'user.email=itt@local', '-c', 'user.name=ITT', 'commit', '--only', '-m', `Publish ${label}`, '--', ...files]);
      }
    }
    verifyCandidate(candidate);
    const revision = git(candidate.worktree, ['rev-parse', 'HEAD']).trim();
    preparedRevision = revision;
    journal('source_prepared');
    sourceMutationStarted = true;
    git(candidate.brainDir, ['-c', 'user.email=itt@local', '-c', 'user.name=ITT', 'merge', '--no-ff', '-m', `Publish ${label}`, revision]);
    sourceCommitted = true;
    journal('source_committed');
    if (fs.existsSync(candidate.intentsDir)) fs.renameSync(candidate.intentsDir, backup);
    try { fs.renameSync(stage, candidate.intentsDir); }
    catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, candidate.intentsDir); throw error; }
    journal('completed');
    fs.rmSync(lock, { recursive: true });
  } catch (error) {
    if (transactionCreated) journal(sourceMutationStarted ? 'needs_recovery' : 'failed', String(error));
    if (!sourceMutationStarted) fs.rmSync(lock, { recursive: true, force: true });
    throw error;
  }
}

/** Explicit operator recovery; never discards source edits or re-executes AI work. */
export function recoverPublication(intentsDir: string, action: 'complete' | 'abort'): void {
  const parent = path.dirname(intentsDir);
  const lock = path.join(parent, '.intentorch-publication-lock');
  const lease = JSON.parse(fs.readFileSync(path.join(lock, 'transaction.json'), 'utf8')) as { transaction: string; candidateId: string };
  if (!/^[a-f0-9]{64}$/.test(lease.candidateId)) throw new Error('Invalid recovery candidate ID');
  const transaction = path.join(parent, '.intentorch-publications', lease.candidateId);
  if (path.resolve(transaction) !== path.resolve(lease.transaction)) throw new Error('Invalid publication recovery path');
  const candidate = JSON.parse(fs.readFileSync(path.join(transaction, 'candidate.json'), 'utf8')) as PublicationCandidate;
  const { id, ...content } = candidate;
  if (id !== lease.candidateId || id !== candidateId(content) || path.resolve(candidate.intentsDir) !== path.resolve(intentsDir)) throw new Error('Invalid saved publication candidate');
  const journalPath = path.join(transaction, 'journal.json');
  const record = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  const stage = path.join(transaction, 'artifacts'), backup = path.join(transaction, 'previous-artifacts');
  const head = git(candidate.brainDir, ['rev-parse', 'HEAD']).trim();
  let mergePending = false;
  try { git(candidate.brainDir, ['rev-parse', '--verify', 'MERGE_HEAD']); mergePending = true; } catch { /* no in-progress merge */ }
  if (mergePending) throw new Error('Brain has an unresolved merge; inspect it before recovery');
  if (git(candidate.brainDir, ['status', '--porcelain', '--untracked-files=all']).trim()) throw new Error('Brain has changes or conflicts; resolve them before recovery');
  const save = (phase: string) => {
    fs.writeFileSync(journalPath + '.tmp', JSON.stringify({ ...record, phase, recoveredAt: new Date().toISOString(), sourceRevision: head }, null, 2));
    fs.renameSync(journalPath + '.tmp', journalPath);
    fs.rmSync(lock, { recursive: true });
  };
  const currentDigest = digest(readArtifactTree(intentsDir));
  if (action === 'abort') {
    if (head !== candidate.baseRevision || currentDigest !== candidate.targetDigest || fs.existsSync(backup)) throw new Error('Publication already changed source or artifacts; cannot abort without an explicit migration');
    save('aborted'); return;
  }
  // A crash can occur after git merge succeeds but before the journal is updated.
  // Prove the resulting source tree exactly matches the prepared revision.
  if (!record.preparedRevision || head === candidate.baseRevision ||
      git(candidate.brainDir, ['rev-parse', `${head}^{tree}`]).trim() !== git(candidate.brainDir, ['rev-parse', `${record.preparedRevision}^{tree}`]).trim()) {
    throw new Error('Published source revision is not proven; inspect the transaction before recovery');
  }
  const expected = digest(candidate.artifacts);
  if (currentDigest === expected) { save('completed'); return; }
  if (digest(readArtifactTree(stage)) !== expected) throw new Error('Staged artifacts changed or are missing; recovery stopped');
  if (fs.existsSync(intentsDir)) {
    if (currentDigest !== candidate.targetDigest || fs.existsSync(backup)) throw new Error('Installed artifacts changed; recovery will not overwrite them');
    fs.renameSync(intentsDir, backup);
  } else if (digest(readArtifactTree(backup)) !== candidate.targetDigest) throw new Error('Previous artifacts cannot be verified');
  try { fs.renameSync(stage, intentsDir); }
  catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, intentsDir); throw error; }
  save('completed');
}

/** Refuse new snapshot reads during publication or if a directory switch occurs mid-read. */
export function withStableArtifactTree<T>(intentsDir: string, read: () => T): T {
  const lock = path.join(path.dirname(intentsDir), '.intentorch-publication-lock');
  const identity = () => {
    if (fs.existsSync(lock)) throw new Error('Workflow publication is active or needs recovery; retry after it completes');
    if (!fs.existsSync(intentsDir)) return undefined;
    const stat = fs.statSync(intentsDir); return `${stat.dev}:${stat.ino}`;
  };
  const before = identity();
  const value = read();
  if (before !== identity()) throw new Error('Workflow artifacts changed while reading; retry with the published version');
  return value;
}
