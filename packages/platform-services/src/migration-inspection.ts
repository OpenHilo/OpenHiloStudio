import * as fs from 'fs';
import { decodeCheckpointStack } from '@openhilo/runtime/state-graph';
import type { CheckpointFrame } from '@openhilo/runtime-contracts';
import * as path from 'path';
import { readCompatibleConfig } from './deployment-config';

type RecordValue = Record<string, unknown>;
export interface MigrationInspection {
  version: 1;
  sourceDir: string;
  scanComplete: boolean;
  activation: 'not_checked';
  issues: Array<{ file: string; code: string; action: string }>;
  paths: Array<{ keys?: Array<string | number>; record?: 'json' | 'final_checkpoint'; file: string; field: string; value: string; location: 'inside_source' | 'outside_source' | 'relative'; existsWithinSource?: boolean }>;
  dependencies: Array<{ file: string; kind: 'application' | 'executor' | 'policy'; id: string; version?: number; inferred?: boolean }>;
  runs: Array<{ file: string; id: string; status: string; humanCheckpoint: 'candidate' | 'missing_or_invalid' | 'not_checked'; lockPresent: boolean }>;
  sessions: Array<{ file: string; id: string; phase: string; disposition: 'terminal' | 'review' | 'requires_decision'; pendingQuestion: boolean; retainedWorktree: boolean }>;
  questions: Array<{ file: string; pending: number; answering: number; outcomeUnknown: number }>;
  schedules: Array<{ file: string; id: string; enabled: boolean }>;
  worktrees: Array<{ file: string; slot: string; status: string; sessionId?: string }>;
}
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined;
const contained = (relative: string): boolean => relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);

/** Read-only offline inventory. It never follows links, probes processes, reconnects providers or activates data.
 * Only recognized metadata fields are projected; prompts, answers, scopes, credentials and arbitrary payloads stay private.
 */
export function inspectMigrationSource(options: { sourceDir: string; maxEntries?: number; maxFileBytes?: number; configuration?: { read?: typeof readCompatibleConfig; defaultApplication?: RecordValue; defaultExecution?: RecordValue } }): MigrationInspection {
  if (!path.isAbsolute(options.sourceDir)) throw new Error('Inspection source must be an explicit absolute directory');
  const sourceDir = fs.realpathSync(options.sourceDir);
  if (!fs.statSync(sourceDir).isDirectory()) throw new Error('Inspection source must be a directory');
  const maxEntries = options.maxEntries ?? 100_000, maxFileBytes = options.maxFileBytes ?? 16 * 1024 * 1024;
  if (![maxEntries, maxFileBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Inspection limits must be positive integers');
  const report: MigrationInspection = { version: 1, sourceDir, scanComplete: true, activation: 'not_checked', issues: [], paths: [], dependencies: [], runs: [], sessions: [], questions: [], schedules: [], worktrees: [] };
  const files = new Set<string>(), directories = new Set<string>(['.']);
  const issueKeys = new Set<string>(), dependencyKeys = new Set<string>();
  const issue = (file: string, code: string, action: string, incomplete = false) => {
    const key = JSON.stringify([file, code, action]);
    if (!issueKeys.has(key)) { issueKeys.add(key); report.issues.push({ file, code, action }); }
    if (incomplete) report.scanComplete = false;
  };
  let entries = 0, exhausted = false;
  function walk(directory: string, prefix: string) {
    let children: string[];
    try { children = fs.readdirSync(directory).sort(); } catch { issue(prefix || '.', 'unreadable_directory', 'Restore access and repeat inspection', true); return; }
    for (const name of children) {
      if (exhausted) return;
      if (++entries > maxEntries) { exhausted = true; issue(prefix || '.', 'scan_limit', 'Raise the explicit scan limit and inspect again', true); return; }
      const relative = prefix ? `${prefix}/${name}` : name, absolute = path.join(directory, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(absolute); } catch { issue(relative, 'unreadable_entry', 'Inspect this entry before migration', true); continue; }
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) { issue(relative, 'unsupported_entry', 'Resolve links/special files explicitly; they are not followed or copied', true); continue; }
      if (stat.isDirectory()) {
        directories.add(relative);
        // Git object/log/reference contents are not migration records; gitdir/commondir metadata is scanned.
        if (/(^|\/)\.git\/(objects|logs|refs)$/.test(relative)) continue;
        walk(absolute, relative);
      } else files.add(relative);
    }
  }
  walk(sourceDir, '');
  function read(file: string): string | undefined {
    if (!files.has(file)) return undefined;
    try {
      const absolute = path.join(sourceDir, file), stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || !contained(path.relative(sourceDir, fs.realpathSync(absolute)))) throw new Error();
      if (stat.size > maxFileBytes) { issue(file, 'file_limit', 'Inspect the oversized metadata file with an explicit higher limit', true); return undefined; }
      return fs.readFileSync(absolute, 'utf8');
    } catch { issue(file, 'unreadable_file', 'Resolve the read failure and repeat inspection', true); return undefined; }
  }
  function json(file: string): unknown {
    const content = read(file); if (content === undefined) return undefined;
    try { return JSON.parse(content); } catch { issue(file, 'invalid_json', 'Repair or preserve the corrupt record before using it', true); return undefined; }
  }
  function ref(file: string, field: string, value: unknown, relativeBase?: string | string[], keys?: Array<string | number>, sourceRecord: 'json' | 'final_checkpoint' = 'json') {
    if (typeof value !== 'string' || !value.length) return;
    if (!path.isAbsolute(value)) {
      const bases = relativeBase === undefined ? [] : Array.isArray(relativeBase) ? relativeBase : [relativeBase];
      const relatives = bases.map(base => path.relative(sourceDir, path.resolve(sourceDir, base, value)));
      const safe = relatives.length > 0 && relatives.every(contained);
      report.paths.push({ ...(keys ? { keys, record: sourceRecord } : {}), file, field, value, location: 'relative', ...(safe ? { existsWithinSource: relatives.some(relative => files.has(relative.split(path.sep).join('/')) || directories.has(relative.split(path.sep).join('/') || '.')) } : {}) });
      if (relatives.some(relative => !contained(relative)) || Array.isArray(relativeBase) && value.split(/[\\/]/).includes('..')) issue(file, 'relative_path_escape', 'Resolve the escaping relative reference explicitly');
      return;
    }
    // Recognize the caller's explicit source alias (e.g. macOS /tmp) without
    // probing the referenced path or resolving arbitrary external symlinks.
    const canonicalRelative = path.relative(sourceDir, value);
    const inputRelative = path.relative(path.resolve(options.sourceDir), value);
    const relative = contained(canonicalRelative) ? canonicalRelative : contained(inputRelative) ? inputRelative : canonicalRelative;
    const inside = contained(relative);
    const normalized = relative.split(path.sep).join('/') || '.';
    const exists = files.has(normalized) || directories.has(normalized);
    report.paths.push({ ...(keys ? { keys, record: sourceRecord } : {}), file, field, value, location: inside ? 'inside_source' : 'outside_source', ...(inside ? { existsWithinSource: exists } : {}) });
    issue(file, inside ? 'absolute_path_binding' : 'external_path_binding', inside ? 'Rebind explicitly if the copied deployment moves; do not rewrite arbitrary content' : 'Confirm ownership and intended target; external paths are never probed or copied');
  }
  function dependency(file: string, kind: 'application' | 'executor' | 'policy', value: unknown, inferred = false) {
    const data = record(value), id = text(data?.id) ?? text(data?.namespace) ?? text(data?.adapter) ?? text(value);
    if (!id) return;
    const entry = { file, kind, id, ...(Number.isSafeInteger(data?.version) ? { version: data!.version as number } : {}), ...(inferred ? { inferred: true } : {}) };
    const key = JSON.stringify(entry);
    if (!dependencyKeys.has(key)) { dependencyKeys.add(key); report.dependencies.push(entry); }
  }
  function checkpoint(file: string): boolean {
    const logFile = `${path.posix.dirname(file)}/execution.jsonl`, content = read(logFile);
    if (content === undefined) return false;
    const lines = content.split('\n').filter(line => line.trim());
    const parsed: RecordValue[] = [];
    for (const line of lines) {
      try { const value = record(JSON.parse(line)); if (!value || typeof value.event !== 'string') throw new Error(); parsed.push(value); }
      catch { issue(logFile, 'invalid_history_line', 'History has malformed lines; preserve it for manual review', true); return false; }
    }
    const last = parsed.at(-1);
    let frames: CheckpointFrame[];
    try { frames = decodeCheckpointStack(last?.call_stack); } catch { return false; }
    if (last?.event !== 'suspended_state' || !frames.length || !Number.isSafeInteger(last.global_seq) || (last.global_seq as number) < 0 || typeof last.ts !== 'number' || !Number.isFinite(last.ts)) return false;
    const boundary = [...parsed].reverse().find(value => ['node_suspended', 'run_start', 'run_resume', 'run_failed'].includes(value.event as string));
    if (boundary?.event !== 'node_suspended' || !text(boundary.node_run_id)) return false;
    for (const [index, value] of frames.entries()) {
      const frame = record(value);
      if (!frame || !Array.isArray(frame.scope_stack)) return false;
      for (const [scopeIndex, scope] of frame.scope_stack.entries()) ref(logFile, `call_stack[${index}].scope_stack[${scopeIndex}].vars.ITT_WORKSPACE`, record(record(scope)?.vars)?.ITT_WORKSPACE, undefined, ['call_stack', index, 'scope_stack', scopeIndex, 'vars', 'ITT_WORKSPACE'], 'final_checkpoint');
      if (Array.isArray(frame.extension_state)) for (const state of frame.extension_state) dependency(logFile, 'policy', state);
      else issue(logFile, 'legacy_policy_state', 'Select the explicit legacy policy migration required for these frames');
    }
    const top = record(frames.at(-1))!, intent = text(top.intent_name), nodeId = text(top.current_node);
    if (!intent || !nodeId) return false;
    const snapshotDir = `${path.posix.dirname(file)}/.snapshot`;
    const candidate = path.posix.normalize(`${snapshotDir}/${intent}.itt.impl.json`);
    if (!candidate.startsWith(snapshotDir + '/')) return false;
    const snapshot = record(json(files.has(candidate) ? candidate : candidate.replace(/\.impl\.json$/, '.json')));
    const nodes = record(snapshot?.nodes), node = record(nodes?.[nodeId]);
    return node?.executor === 'human';
  }
  const config = json('config.json');
  if (config !== undefined) {
    try {
      const view = (options.configuration?.read ?? readCompatibleConfig)(config);
      dependency('config.json', 'application', view.application ?? options.configuration?.defaultApplication, view.application === undefined);
      dependency('config.json', 'executor', view.ai_execution ?? options.configuration?.defaultExecution, view.ai_execution === undefined);
      if (view.application === undefined && !options.configuration?.defaultApplication || view.ai_execution === undefined && !options.configuration?.defaultExecution) issue('config.json', 'missing_selection', 'Select application and executor explicitly or use the original deployment compatibility policy');
      // Recognize old adapter path metadata without selecting that adapter or
      // projecting its private settings into the public configuration view.
      const root = record(config)!;
      const locations: Array<{ value: RecordValue | undefined; keys: string[] }> = root.format === 'intentorch.deployment'
        ? [{ value: record(record(root.core)?.legacyFields), keys: ['core', 'legacyFields'] },
           { value: record(record(record(root.ai)?.implementations)?.['claude-code']), keys: ['ai', 'implementations', 'claude-code'] }]
        : [{ value: record(root.defaults ?? root), keys: root.defaults != null ? ['defaults'] : [] }];
      for (const location of locations) for (const key of ['claude_path', 'mcp_server_js']) {
        const value = location.value?.[key];
        if (typeof value === 'string' && path.isAbsolute(value)) ref('config.json', key, value, undefined, [...location.keys, key]);
      }
    } catch { issue('config.json', 'invalid_configuration', 'Validate configuration format and selected application/executor before activation', true); }
  } else if (!files.has('config.json')) issue('config.json', 'missing_configuration', 'Select application and executor explicitly; do not infer them from a new host');
  for (const file of files) {
    const name = path.posix.basename(file);
    if (file.startsWith('runs/') && file.includes('/.snapshot/') && /\.itt(?:\.impl)?\.json$/.test(name)) {
      const snapshot = record(json(file));
      if (!snapshot) { issue(file, 'invalid_snapshot', 'Preserve and review the invalid workflow snapshot', true); continue; }
      if (Array.isArray(snapshot.requiredExtensions)) for (const extension of snapshot.requiredExtensions) dependency(file, 'policy', extension);
      if (snapshot.level !== undefined) issue(file, 'legacy_domain_metadata', 'Resolve legacy domain metadata with the selected application policy before restoring');
    }
    if (name === '.git' || name === 'commondir' || (name === 'gitdir' && file.includes('.git/'))) {
      const value = read(file)?.trim().replace(/^gitdir:\s*/, '');
      if (value) { ref(file, 'gitdir', value, path.posix.dirname(file)); issue(file, 'git_worktree_binding', 'Re-register/rebind the copied worktree explicitly; never run Git through an old absolute pointer'); }
    }
    if (name === 'run.lock') issue(file, 'run_lock', 'Inspect process ownership separately; this tool never probes PIDs or removes locks');
    if (file.startsWith('runs/') && name === 'run.json') {
      const value = record(json(file));
      if (!value || !text(value.run_id) || !text(value.status)) { issue(file, 'invalid_run', 'Preserve and review the invalid run receipt', true); continue; }
      const candidate = value.status === 'suspended' ? checkpoint(file) : false;
      report.runs.push({ file, id: value.run_id as string, status: value.status as string, humanCheckpoint: value.status === 'suspended' ? candidate ? 'candidate' : 'missing_or_invalid' : 'not_checked', lockPresent: files.has(`${path.posix.dirname(file)}/run.lock`) });
      if (value.status === 'running') issue(file, 'unfinished_run', 'Finish, explicitly stop, or investigate this run before migration; saved status does not prove a live process');
      if (value.status === 'suspended') issue(file, candidate ? 'human_restore_validation' : 'missing_human_checkpoint', candidate ? 'Validate policy versions, paths and human outputs in a copy before resuming' : 'Do not resume without a valid final human suspension and snapshot');
      if (!value.application || !value.ai_execution && !value.aiExecutorId) issue(file, 'legacy_run_selection', 'Resolve missing saved application/executor identity explicitly; do not adopt current defaults');
      dependency(file, 'application', value.application); dependency(file, 'executor', value.ai_execution ?? value.aiExecutorId);
      for (const key of ['workdir', 'ittPath', 'itt_home']) ref(file, key, value[key], key === 'ittPath' ? ['intents', 'intents/dev', 'intents/shared'] : undefined, [key]);
    }
    if (name === 'session.json' && /^(translator-sessions|sessions)\//.test(file)) {
      const value = record(json(file));
      if (!value || !text(value.id) || !text(value.phase)) { issue(file, 'invalid_session', 'Preserve and review the invalid generation snapshot', true); continue; }
      const terminal = value.phase === 'done' || value.phase === 'error' && record(value.lastError)?.retryable === false;
      const disposition = terminal ? 'terminal' : value.phase === 'confirm_merge' ? 'review' : 'requires_decision';
      report.sessions.push({ file, id: value.id as string, phase: value.phase as string, disposition, pendingQuestion: !!value.pendingMcpQuestion, retainedWorktree: !!value.worktreePath });
      if (!terminal) issue(file, disposition === 'review' ? 'pending_publication_review' : 'unfinished_generation', disposition === 'review' ? 'Preserve candidate and lease; revalidate publication targets before approval' : 'Finish, save, or explicitly terminate the session before upgrading; in-memory AI context is not migrated');
      dependency(file, 'executor', value.aiExecutorId ?? (value.tmuxSessionName ? 'claude-code' : undefined), !value.aiExecutorId);
      dependency(file, 'policy', value.generationPolicyIdentity ?? value.generationPolicyState);
      for (const key of ['sessionDir', 'worktreePath', 'archivedWorktreePath', 'currentSignalPath', 'savedPath']) ref(file, key, value[key], undefined, [key]);
      if (Array.isArray(value.savedPaths)) for (const [index, saved] of value.savedPaths.entries()) ref(file, `savedPaths[${index}]`, saved, undefined, ['savedPaths', index]);
      const settings = record(value.config);
      if (settings) { dependency(file, 'application', settings.application); for (const key of ['workspace', 'sessionDir', 'dbPath', 'intentsDir', 'publicationDir', 'defaultOutputDir', 'worktreePath']) ref(file, `config.${key}`, settings[key], undefined, ['config', key]); }
    }
    if (name === 'ai-questions.json' && file.startsWith('runs/')) {
      const value = record(json(file));
      if (value?.version !== 1 || !Array.isArray(value.questions)) { issue(file, 'invalid_questions', 'Review the unsupported question history', true); continue; }
      const states = value.questions.map(question => record(question)?.status);
      if (states.some(status => !['pending', 'answering', 'answered', 'closed', 'outcome_unknown'].includes(status as string))) issue(file, 'invalid_questions', 'Review malformed question records', true);
      const summary = { file, pending: states.filter(state => state === 'pending').length, answering: states.filter(state => state === 'answering').length, outcomeUnknown: states.filter(state => state === 'outcome_unknown').length };
      report.questions.push(summary);
      if (summary.pending || summary.answering || summary.outcomeUnknown) issue(file, 'unsettled_ai_questions', 'Resolve pending/unknown answer outcomes with the original owner; never automatically resend');
    }
    if (file === 'platform/schedules.json' || file === 'schedules.json') {
      const schedules = json(file);
      if (!Array.isArray(schedules)) { issue(file, 'invalid_schedules', 'Review invalid schedule storage before starting timers', true); continue; }
      for (const [index, item] of schedules.entries()) {
        const value = record(item);
        if (!value || !text(value.id) || typeof value.enabled !== 'boolean') { issue(file, 'invalid_schedule', 'Review malformed schedule metadata', true); continue; }
        report.schedules.push({ file, id: value.id as string, enabled: value.enabled });
        if (value.enabled) issue(file, 'enabled_schedule', 'Keep timers stopped until workflow and workspace targets are verified');
        ref(file, `schedule[${value.id}].ittPath`, value.ittPath, ['intents', 'intents/dev', 'intents/shared'], [index, 'ittPath']); ref(file, `schedule[${value.id}].workdir`, value.workdir, undefined, [index, 'workdir']);
      }
    }
    if (name === 'pool-state.json') {
      const value = record(json(file)), slots = record(value?.slots);
      // The legacy pool stored { "ws-01": "active:<session>", "ws-02": "idle" }.
      // Match WorktreePool's conservative compatibility view without upgrading
      // the file or treating an old idle label as permission to reuse it.
      if (value && !Object.hasOwn(value, 'version')) {
        for (const [slot, status] of Object.entries(value)) {
          if (!/^ws-\d+$/.test(slot) || typeof status !== 'string') {
            issue(file, 'invalid_lease', 'Review malformed legacy worktree ownership', true); continue;
          }
          const sessionId = status.startsWith('active:') ? status.slice(7) : '';
          report.worktrees.push({ file, slot, status: sessionId ? 'active' : 'retained', ...(sessionId ? { sessionId } : {}) });
          issue(file, 'retained_worktree', 'Preserve the legacy workspace; verify saved ownership before claim, archival or reuse');
        }
        continue;
      }
      if (value?.version !== 1 || !slots) { issue(file, 'invalid_pool', 'Preserve and inspect unknown worktree ownership metadata', true); continue; }
      for (const [slot, raw] of Object.entries(slots)) {
        const lease = record(raw);
        if (!lease || !text(lease.status)) { issue(file, 'invalid_lease', 'Review malformed worktree ownership', true); continue; }
        report.worktrees.push({ file, slot, status: lease.status as string, ...(text(lease.sessionId) ? { sessionId: lease.sessionId as string } : {}) });
        if (!['idle', 'vacant'].includes(lease.status as string)) issue(file, 'retained_worktree', 'Preserve the lease and candidate; explicitly resolve ownership before reuse');
        ref(file, `slot[${slot}].archivePath`, lease.archivePath, undefined, ['slots', slot, 'archivePath']);
      }
    }
  }
  return report;
}
