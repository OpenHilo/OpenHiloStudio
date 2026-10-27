import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { splitSession } from './workflow-files';
import type { ProgramInput, ProgramResult } from '@openhilo/compiler';
import { platformSystemMethods } from './compiler-capabilities';
import { git, digest, safeFile, readArtifactTree, readCompilationInputs, prepareCandidate, publishCandidate } from './publication';

import type { PreflightResult, GenerationPreflightOptions } from './generation-ports';
export type { PreflightResult, GenerationPreflightOptions } from './generation-ports';

export interface DiffClassification {
  added: string[];
  modified: string[];
  deleted: string[];
}

/**
 * Parse raw `git diff --name-status` output into A/M/D buckets.
 * Only includes .ts files (excludes tsconfig.json, sys-globals.d.ts, etc.).
 */
export function classifyDiffOutput(raw: string): DiffClassification {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of raw.trim().split('\n').filter(Boolean)) {
    const [status, ...fileParts] = line.split('\t');
    const file = fileParts.join('\t');
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    if (status === 'A') added.push(file);
    else if (status === 'M') modified.push(file);
    else if (status?.startsWith('D')) deleted.push(file);
  }

  return { added, modified, deleted };
}

export function deriveNamespace(tsAbsPath: string, brainDir: string): string {
  const rel = path.relative(brainDir, tsAbsPath);
  const parts = rel.split(path.sep);
  parts.pop(); // remove filename
  return parts.join('.');
}


/** Preflight uses temporary artifact storage and never changes installed Brain/ITT files. */
export interface GenerationPipelineConfig {
  brainDir: string;
  intentsDir: string;
  /** Override only to supply application-specific validation or another source layout. */
  compileSource?: typeof splitSession;
  /** Explicit virtual-module layout. Cannot be combined with the legacy file compiler. */
  compileProgram?: (input: ProgramInput, options: GenerationPreflightOptions) => ProgramResult;
}

export function createGenerationPipeline(config: GenerationPipelineConfig) {
  if (!path.isAbsolute(config.brainDir) || !path.isAbsolute(config.intentsDir)) {
    throw new Error('Generation pipeline directories must be explicit absolute paths');
  }
  if (config.compileSource && config.compileProgram) throw new Error('Select one source layout compiler');
  const brainDir = path.resolve(config.brainDir), intentsDir = path.resolve(config.intentsDir);
  const compileSource = config.compileSource ?? splitSession;
  // A saved receipt proves its contents, not compatibility with the current
  // compiler. Restored candidates use the existing preflight/review path again.
  const validatedCandidates = new WeakSet<NonNullable<PreflightResult['candidate']>>();
  async function runPreflight(worktreePath: string, entries?: string[], options: GenerationPreflightOptions = {}): Promise<PreflightResult> {
    const result: PreflightResult = { ok: false, added: [], modified: [], deleted: [], diffs: {}, contents: {} };
    let temporary: string | undefined;
    try {
      if (options.legacyEntryTags && !config.compileSource && !config.compileProgram) throw new Error('Legacy entry validation requires an application compiler');
      const baseRevision = git(brainDir, ['rev-parse', 'HEAD']).trim();
      // Recompilation cannot advance the candidate's Git ancestry. A receipt
      // for an unsynchronized branch would fail every later approval and send
      // the user back through the same review indefinitely.
      if (git(worktreePath, ['merge-base', baseRevision, 'HEAD']).trim() !== baseRevision) {
        result.requiresTargetSync = true;
        throw new Error('The publication target has advanced. Synchronize this candidate workspace with the current target, resolve any conflicts, then review again. Your candidate is retained; approving again before synchronization cannot publish it.');
      }
      const inputs = readCompilationInputs(worktreePath);
      const inputDigest = digest(inputs);
      const originalArtifacts = readArtifactTree(intentsDir);
      const fields = git(worktreePath, ['diff', '--no-renames', '--name-status', '-z', baseRevision]).split('\0');
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const status = fields[i], file = fields[i + 1];
        if (!file.endsWith('.ts') || file.endsWith('.d.ts')) throw new Error(`Unreviewed non-workflow change: ${file}`);
        if (status === 'A') result.added.push(file);
        else if (status === 'M') result.modified.push(file);
        else if (status === 'D') result.deleted.push(file);
        else throw new Error(`Unsupported Git change ${status}: ${file}`);
      }
      for (const file of git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
        if (file.endsWith('.ts') && !file.endsWith('.d.ts') && !result.added.includes(file)) result.added.push(file);
      }
      if (result.deleted.length) throw new Error(`Workflow deletion requires a separate migration: ${result.deleted.join(', ')}`);
      const changed = [...result.added, ...result.modified].sort();
      if (!changed.length) throw new Error('No workflow source changes to publish');
      for (const file of changed) result.contents[file] = fs.readFileSync(safeFile(worktreePath, file), 'utf8');
      for (const file of result.modified) result.diffs[file] = git(worktreePath, ['diff', baseRevision, '--', file]);
      execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', path.join(worktreePath, 'tsconfig.json')], { encoding: 'utf8', stdio: 'pipe' });
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-preflight-'));
      const sourceDir = path.join(temporary, 'brain');
      const artifactDir = path.join(temporary, 'intents');
      fs.mkdirSync(sourceDir); fs.mkdirSync(artifactDir);
      for (const [file, source] of Object.entries(inputs)) {
        const target = safeFile(sourceDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source);
      }
      for (const [file, content] of Object.entries(originalArtifacts)) {
        const target = safeFile(artifactDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.from(content, 'base64'));
      }
      if (config.compileProgram) {
        // A module deployment compiles the closed source graph, including unchanged
        // dependants. Never resolve imports against stale installed declarations.
        const files = Object.fromEntries(Object.entries(inputs).filter(([file]) => file.endsWith('.ts') && !file.endsWith('.d.ts')));
        const selectedEntries = (entries ?? []).map(entry => {
          const parts = entry.split('/'), exportName = parts.pop()!;
          const file = parts.join('/') + '.ts';
          if (!exportName || !Object.hasOwn(files, file)) throw new Error(`Module entry must name <source-without-.ts>/<export>: ${entry}`);
          return { file, exportName };
        });
        const compiled = config.compileProgram({ files, entries: selectedEntries, systemMethods: platformSystemMethods }, JSON.parse(JSON.stringify(options)));
        if (!compiled.ok) throw new Error(compiled.diagnostics.map(item => `${item.file ?? 'program'}${item.line ? `:${item.line}:${item.column ?? 1}` : ''}: ${item.message}`).join('\n'));
        const emitted = new Map<string, string>();
        for (const artifact of compiled.artifacts) {
          const { declaration, implementation } = artifact;
          if (artifact.id !== [declaration.namespace, declaration.name].filter(Boolean).join('.') || declaration.name !== implementation.name || declaration.namespace !== implementation.namespace)
            throw new Error('Module artifact identity does not match its declaration and implementation');
          const directory = artifact.id.split('.').join('/'), name = declaration.name;
          const source = files[artifact.file];
          if (source === undefined) throw new Error(`Module artifact has an unknown source: ${artifact.file}`);
          const metadata = { sourceTs: 'sha256:' + createHash('sha256').update(source).digest('hex'), sourceFile: artifact.file };
          for (const [suffix, content] of [
            ['itt.json', { ...declaration, ...metadata }],
            ['itt.impl.json', { ...implementation, ...metadata }],
            ['source-map.json', { version: 1, file: artifact.file, sourceTs: metadata.sourceTs, nodes: artifact.sourceMap }],
          ] as const) {
            const file = `${directory}/${name}.${suffix}`;
            if (emitted.has(file)) throw new Error(`Duplicate module artifact: ${file}`);
            emitted.set(file, JSON.stringify(content, null, 2));
          }
        }
        // Layout changes or removal of a formerly installed symbol need an explicit
        // migration. Keep unrelated artifact data, but never leave stale executable ITT.
        for (const file of Object.keys(originalArtifacts)) {
          if ((file.endsWith('.itt.json') || file.endsWith('.itt.impl.json') || file.endsWith('.source-map.json')) && !emitted.has(file))
            throw new Error(`Installed workflow removal or layout change requires a separate migration: ${file}`);
        }
        for (const [file, content] of emitted) {
          const target = safeFile(artifactDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
        }
        for (const [file, content] of emitted) {
          if (fs.readFileSync(safeFile(artifactDir, file), 'utf8') !== content)
            throw new Error(`Workflow artifact path collision: ${file}. Choose distinct names for this filesystem.`);
        }
      } else {
        const expectedArtifacts = new Map<string, { name: string; namespace: string }>();
        // Existing file-layout dependencies may need newly compiled declarations first.
        let pending = changed;
        while (pending.length) {
          const next: string[] = []; const errors: string[] = [];
          for (const file of pending) {
            try {
              const ns = deriveNamespace(path.join(sourceDir, file), sourceDir);
              const compiled = compileSource(result.contents[file], sourceDir, artifactDir, ns, { ...JSON.parse(JSON.stringify(options)), writeSources: false });
              if (!compiled.intents.length) throw new Error(`No workflow emitted for ${file}; the legacy layout requires a namespace directory`);
              // Sources remain the approved input files, rather than the extracted
              // per-function files used by splitSession's standalone write mode.
              const metadata = { sourceTs: 'sha256:' + createHash('sha256').update(result.contents[file]).digest('hex'), sourceFile: file };
              for (const intent of compiled.intents) {
                for (const suffix of ['itt.json', 'itt.impl.json']) {
                  const relative = [...intent.namespace.split('.'), intent.name, `${intent.name}.${suffix}`].join('/');
                  if (expectedArtifacts.has(relative)) throw new Error(`Workflow artifact collision: ${relative}. Choose distinct names.`);
                  expectedArtifacts.set(relative, { name: intent.name, namespace: intent.namespace });
                  const target = safeFile(artifactDir, relative);
                  const artifact = JSON.parse(fs.readFileSync(target, 'utf8'));
                  fs.writeFileSync(target, JSON.stringify({ ...artifact, ...metadata }, null, 2));
                }
              }
            } catch (error) { next.push(file); errors.push(`${file}: ${String(error)}`); }
          }
          if (next.length === pending.length) throw new Error(errors.join('\n'));
          pending = next;
        }
        for (const [file, expected] of expectedArtifacts) {
          const actual = JSON.parse(fs.readFileSync(safeFile(artifactDir, file), 'utf8'));
          if (actual.name !== expected.name || actual.namespace !== expected.namespace)
            throw new Error(`Workflow artifact path collision: ${file}. Choose distinct names for this filesystem.`);
        }
      }
      for (const entry of entries ?? []) {
        const leaf = entry.split('/').at(-1)!;
        if (!fs.existsSync(safeFile(artifactDir, `${entry}/${leaf}.itt.impl.json`))) throw new Error(`Generated entry has no compiled workflow: ${entry}`);
      }
      if (inputDigest !== digest(readCompilationInputs(worktreePath)) || baseRevision !== git(brainDir, ['rev-parse', 'HEAD']).trim() || digest(originalArtifacts) !== digest(readArtifactTree(intentsDir)))
        throw new Error('Compilation inputs or publication target changed during preflight; retry preflight');
      result.candidate = prepareCandidate({ worktree: path.resolve(worktreePath), brainDir: path.resolve(brainDir), intentsDir,
        sources: result.contents, artifacts: readArtifactTree(artifactDir) });
      validatedCandidates.add(result.candidate);
      result.ok = true;
    } catch (error) {
      const details = error as { stdout?: string; stderr?: string; message?: string };
      result.compileErrors = details.stdout || details.stderr || details.message || String(error);
    } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
    return result;
  }

  async function executeMerge(worktreePath: string, preflight: PreflightResult, entries: string[]): Promise<void> {
    if (!preflight.ok || !preflight.candidate || path.resolve(worktreePath) !== preflight.candidate.worktree)
      throw new Error('A current publication receipt is required; run preflight and review again');
    if (preflight.candidate.brainDir !== brainDir || preflight.candidate.intentsDir !== intentsDir) throw new Error('Publication receipt belongs to a different configured target');
    if (!validatedCandidates.has(preflight.candidate))
      throw new Error('Restored candidate requires validation by the current compiler; run preflight and review again');
    publishCandidate(preflight.candidate, entries.join(', ') || 'workflows');
  }

  return { sourceLayout: config.compileProgram ? 'modules' as const : 'legacy-files' as const, runPreflight, executeMerge };
}
