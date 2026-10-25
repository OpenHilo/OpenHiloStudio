/** Read-only human-node views over explicit run directories and their historical snapshots. */
import * as fs from 'fs';
import * as path from 'path';
import { decodeCheckpointStack } from '@openhilo/runtime/state-graph';
import type { LogEvent, CheckpointFrame, Scope } from '@openhilo/runtime-contracts';
import type { ValueType } from '@openhilo/itt-contracts';
import type { HumanSubmission } from '@openhilo/human-contracts';
import { currentHumanTask, readHumanSubmission } from '@openhilo/runtime/human-tasks';

type HumanNode = { executor?: string; intent?: string; callee?: string; inputsFrom?: Record<string, string>; outputsTo?: Record<string, string>; outputs?: Record<string, ValueType> };
export interface HumanNodeInfo {
  nodeId: string; prompt: string; resolvedInputs: Record<string, string>; suspendedAt: string;
  nodeRunId?: string; taskId?: string; intent?: string; frameId?: string;
  outputs?: Array<{ name: string; kind: ValueType }>;
  acceptedSubmission?: HumanSubmission;
}
export interface HumanHistoryItem {
  nodeRunId: string; nodeId: string; prompt: string; resolvedInputs: Record<string, unknown>;
  outputTypes: Array<{ name: string; kind: string }>; result?: Record<string, unknown>;
  startedAt: string; completedAt?: string; status: 'completed' | 'suspended' | 'failed' | 'incomplete'; error?: string;
  intent?: string; frameId?: string; attemptNodeRunIds?: string[]; taskId?: string;
  acceptedSubmission?: HumanSubmission;
}

/** Historical malformed lines are tolerated, but the final line's validity is tracked separately. */
function readEvents(runDir: string): { events: LogEvent[]; finalValid: boolean } {
  const file = path.join(runDir, 'execution.jsonl');
  if (!fs.existsSync(file)) return { events: [], finalValid: true };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim());
  const events: LogEvent[] = []; let finalValid = true;
  for (const [index, line] of lines.entries()) {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || typeof value.event !== 'string') throw new Error('Invalid event');
      events.push(value as LogEvent);
    } catch { if (index === lines.length - 1) finalValid = false; }
  }
  return { events, finalValid };
}
function containedFile(directory: string, relative: string): string | undefined {
  const root = path.resolve(directory), file = path.resolve(root, relative);
  if (file === root || !file.startsWith(root + path.sep)) return undefined;
  if (!fs.existsSync(file)) return undefined;
  const actualRoot = fs.realpathSync(root), actualFile = fs.realpathSync(file);
  if (actualRoot !== path.join(fs.realpathSync(path.dirname(root)), path.basename(root))) return undefined;
  return actualFile.startsWith(actualRoot + path.sep) && fs.statSync(actualFile).isFile() ? actualFile : undefined;
}
function readNode(runDir: string, intent: string, nodeId: string): HumanNode | undefined {
  const directory = path.join(runDir, '.snapshot');
  const file = containedFile(directory, `${intent}.itt.impl.json`) ?? containedFile(directory, `${intent}.itt.json`);
  if (!file) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')).nodes?.[nodeId] as HumanNode | undefined;
}
function recordedInputs(runDir: string, nodeRunId: string | undefined): Record<string, unknown> | undefined {
  if (!nodeRunId) return undefined;
  const file = containedFile(path.join(runDir, 'io_records'), `${nodeRunId}_inputs.json`);
  if (!file) return undefined;
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function scopeInputs(node: HumanNode | undefined, scopes: Scope[] | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, reference] of Object.entries(node?.inputsFrom ?? {})) {
    const variable = reference.startsWith('$') ? reference.slice(1) : reference;
    let value: unknown = '';
    for (const scope of [...(Array.isArray(scopes) ? scopes : [])].reverse()) {
      if (scope.vars && Object.hasOwn(scope.vars, variable)) { value = scope.vars[variable]; break; }
    }
    Object.defineProperty(result, name, { value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
const display = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value) ?? '';
function outputTypes(node?: HumanNode): Array<{ name: string; kind: ValueType }> {
  return Object.keys(node?.outputsTo ?? {}).map(name => ({ name, kind: node?.outputs?.[name] ?? 'text' }));
}
function framesOf(event: Extract<LogEvent, { event: 'suspended_state' }>): CheckpointFrame[] {
  try { return decodeCheckpointStack(event.call_stack); } catch { return []; }
}

export function readHumanNodeInfo(runDir: string, intent: string, includeOutputs = false): HumanNodeInfo | null {
  const { events, finalValid } = readEvents(runDir), last = events.at(-1);
  if (!finalValid || last?.event !== 'suspended_state') return null;
  const frame = framesOf(last).at(-1);
  if (!frame || typeof frame.current_node !== 'string' || !Number.isFinite(last.ts)) return null;
  const snapshotIntent = frame.intent_name ?? intent;
  const node = readNode(runDir, snapshotIntent, frame.current_node);
  if (!node || node.executor !== 'human') return null;
  const suspended = [...events].reverse().find(event => event.event === 'node_suspended' || event.event === 'run_start' || event.event === 'run_resume');
  const nodeRunId = suspended?.event === 'node_suspended' ? suspended.node_run_id : undefined;
  const task = currentHumanTask(runDir);
  const taskId = task?.taskId ?? (suspended?.event === 'node_suspended' ? suspended.task_id : undefined);
  const inputs = task?.inputs ?? recordedInputs(runDir, nodeRunId) ?? scopeInputs(node, frame.scope_stack);
  const acceptedSubmission = includeOutputs && task ? readHumanSubmission(runDir, task.taskId) : undefined;
  return { nodeId: frame.current_node, prompt: task?.prompt ?? node.intent ?? node.callee ?? frame.current_node,
    resolvedInputs: Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, display(value)])),
    suspendedAt: new Date(last.ts * 1000).toISOString(), nodeRunId, ...(taskId ? { taskId } : {}), intent: snapshotIntent, frameId: frame.frame_id,
    ...(includeOutputs ? { outputs: task ? Object.entries(task.outputs).map(([name, kind]) => ({ name, kind })) : outputTypes(node) } : {}),
    ...(acceptedSubmission ? { acceptedSubmission } : {}),
  };
}

/** Compatibility async facade for existing HTTP/read-model consumers. */
export async function extractHumanNodeInfo(runDir: string, intent: string, includeOutputs = false): Promise<HumanNodeInfo | null> {
  return readHumanNodeInfo(runDir, intent, includeOutputs);
}

type Attempt = { id: string; nodeId: string; intent: string; frameId?: string; taskId?: string; ts: number; scopes?: Scope[]; suspended?: boolean; error?: string; failedAt?: number; success?: { ts: number; outputs: Record<string, unknown> }; group: Attempt[] };
export async function extractHumanHistory(runDir: string, intent: string): Promise<HumanHistoryItem[]> {
  const { events } = readEvents(runDir), attempts = new Map<string, Attempt>(), groups: Attempt[][] = [];
  let frames: Array<{ frame_id?: string; intent_name: string }> = [{ intent_name: intent }];
  let active: Attempt | undefined, suspended: Attempt | undefined, resumeTarget: Attempt | undefined;
  for (const event of events) {
    if (event.event === 'run_start') { frames = [{ intent_name: event.intent ?? intent }]; suspended = undefined; resumeTarget = undefined; }
    if (event.event === 'frame_push') frames.push({ frame_id: event.frame_id, intent_name: event.callee });
    if (event.event === 'frame_pop') { const index = frames.findIndex(frame => frame.frame_id === event.frame_id); if (index >= 0) frames.splice(index); }
    if (event.event === 'run_resume') resumeTarget = suspended;
    if (event.event === 'node_pending') {
      const current = frames.at(-1);
      if (event.executor === 'human' && typeof event.node_run_id === 'string' && typeof event.node_id === 'string' && Number.isFinite(event.ts)) {
        const frameId = event.frame_id ?? current?.frame_id;
        const snapshotIntent = event.intent_name ?? current?.intent_name ?? intent;
        const continuation = resumeTarget && resumeTarget.nodeId === event.node_id && resumeTarget.intent === snapshotIntent &&
          (!resumeTarget.frameId || !frameId || resumeTarget.frameId === frameId);
        const group: Attempt[] = continuation ? resumeTarget!.group : [];
        active = { id: event.node_run_id, nodeId: event.node_id, frameId, intent: snapshotIntent, ts: event.ts, group };
        group.push(active); if (!continuation) groups.push(group);
        attempts.set(active.id, active);
      } else active = undefined;
      resumeTarget = undefined;
    }
    if (event.event === 'node_suspended') {
      const attempt = attempts.get(event.node_run_id);
      if (attempt) { attempt.suspended = true; attempt.taskId = event.task_id; suspended = attempt; }
    }
    if (event.event === 'suspended_state') {
      const checkpoint = framesOf(event), frame = checkpoint.at(-1);
      if (checkpoint.length) frames = checkpoint;
      if (frame && active?.nodeId === frame.current_node) {
        active.scopes = frame.scope_stack; active.intent = frame.intent_name ?? active.intent; active.frameId = frame.frame_id;
      }
    }
    if (event.event === 'node_failed') {
      const attempt = attempts.get(event.node_run_id);
      if (attempt) { attempt.error = event.error; if (Number.isFinite(event.ts)) attempt.failedAt = event.ts; }
    }
    if (event.event === 'node_success' && Number.isFinite(event.ts)) {
      const attempt = attempts.get(event.node_run_id);
      if (attempt) { attempt.success = { ts: event.ts, outputs: event.outputs ?? {} }; if (suspended?.group === attempt.group) suspended = undefined; if (resumeTarget?.group === attempt.group) resumeTarget = undefined; }
    }
  }
  const items: HumanHistoryItem[] = [];
  for (const group of groups) {
    const first = group[0], completed = [...group].reverse().find(attempt => attempt.success), latest = group.at(-1)!;
    const selected = completed ?? latest;
    const node = readNode(runDir, selected.intent, selected.nodeId);
    const inputs = recordedInputs(runDir, selected.id) ?? scopeInputs(node, selected.scopes ?? first.scopes);
    const taskId = group.find(attempt => attempt.taskId)?.taskId;
    const acceptedSubmission = taskId ? readHumanSubmission(runDir, taskId) : undefined;
    items.push({ ...(acceptedSubmission ? { acceptedSubmission } : {}), nodeRunId: first.id, nodeId: selected.nodeId, intent: selected.intent, frameId: selected.frameId, ...(taskId ? { taskId } : {}),
      attemptNodeRunIds: group.map(attempt => attempt.id), prompt: node?.intent ?? node?.callee ?? selected.nodeId,
      resolvedInputs: inputs, outputTypes: outputTypes(node), startedAt: new Date(first.ts * 1000).toISOString(),
      ...(completed ? { completedAt: new Date(completed.success!.ts * 1000).toISOString(), result: completed.success!.outputs } : {}),
      ...(!completed && latest.failedAt !== undefined ? { completedAt: new Date(latest.failedAt * 1000).toISOString() } : {}),
      ...(latest.error !== undefined ? { error: latest.error } : {}),
      status: completed ? 'completed' : latest.error !== undefined ? 'failed' : latest.suspended ? 'suspended' : 'incomplete' });
  }
  return items;
}
