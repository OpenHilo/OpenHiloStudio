import type {HumanHistoryItem} from '../api/human';
import type {CFGNode, LogEvent} from './trace-layout';
export interface ActivityItem {
  key: string; title: string; kind: string; status: string; executor?: string;
  frameId?: string; nodeRunId?: string; nodeId?: string;
  startedAt?: number; endedAt?: number; inputs?: unknown; outputs?: unknown;
  error?: string; description?: string; sourceEventIndexes: number[];
}
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
export function describeNode(node: CFGNode): {title: string; kind: string; description?: string} {
  const labels: Record<string, string> = {assign: 'Process data', if: 'Choose a branch', while: 'Repeat while', for: 'Repeat', for_each: 'For each item', foreach: 'For each item', return: 'Return result'};
  const condition = text(node.condition);
  const conditionTitle = condition && condition.length < 90 && !condition.includes('__') ? node.type === 'if' ? `If ${condition}` : ['for','while'].includes(node.type) ? `While ${condition}` : undefined : undefined;
  const title = text(node.callee) ?? conditionTitle ?? labels[node.type] ?? (node.type === 'call' ? node.id.replace(/^call_/, '').replace(/_\d+$/, '') : node.id);
  return {title, kind: node.type, description: text(node.intent)};
}
/** Preserve each invocation and its source events, including repeated calls and child frames. */
export function buildExecutionActivity(events: LogEvent[], nodes: Record<string, CFGNode> = {}, includeInternal = false, humanHistory: HumanHistoryItem[] = []): ActivityItem[] {
  const rows = new Map<string, ActivityItem>();
  const rootFrame = events.find(e => e.event === 'node_pending')?.frame_id;
  const statuses: Record<string, string> = {node_pending:'running', node_running:'running', node_success:'completed', node_failed:'failed', node_suspended:'suspended'};
  events.forEach((event, index) => {
    const status = statuses[event.event];
    if (!status) {
      if (event.error && !['ai_health','run_failed','run_abort'].includes(event.event)) {
        const key = `event-${index}`;
        rows.set(key,{key,title:'Execution error',kind:'unknown',status:'failed',error:typeof event.error === 'string' ? event.error : JSON.stringify(event.error),sourceEventIndexes:[index],endedAt:typeof event.ts === 'number' ? event.ts : undefined});
      }
      return;
    }
    const key = text(event.node_run_id) ?? `event-${index}`;
    let row = rows.get(key);
    if (!row) {
      const id = text(event.node_id) ?? 'Unknown step';
      const snapshot = event.frame_id === rootFrame ? nodes[id] : undefined;
      const cfg: CFGNode = snapshot ?? {id, type:text(event.node_type) ?? 'unknown', executor:text(event.executor)};
      const description = describeNode(cfg);
      row = {key, ...description, status, nodeId:text(event.node_id), nodeRunId:text(event.node_run_id), frameId:text(event.frame_id), executor:text(event.executor) ?? cfg.executor, sourceEventIndexes:[]};
      rows.set(key, row);
    }
    row.status = status;
    row.sourceEventIndexes.push(index);
    if (event.event === 'node_pending') {
      row.startedAt = typeof event.ts === 'number' ? event.ts : undefined;
      const metadata = event.inputs as {intent?: unknown} | undefined;
      row.description ??= text(metadata?.intent);
    } else if (event.event !== 'node_running') {
      row.endedAt = typeof event.ts === 'number' ? event.ts : undefined;
    }
    if (event.outputs !== undefined) row.outputs = event.outputs;
    if (event.error !== undefined) row.error = typeof event.error === 'string' ? event.error : JSON.stringify(event.error);
  });
  // The server's durable request groups attempts across suspension, never names.
  for (const request of humanHistory) {
    const ids = new Set(request.attemptNodeRunIds ?? [request.nodeRunId]);
    const attempts = [...rows.values()].filter(row => row.executor === 'human' && row.nodeRunId && ids.has(row.nodeRunId) && (!request.frameId || row.frameId === request.frameId));
    if (!attempts.length) continue;
    const first = attempts[0], last = attempts[attempts.length - 1];
    const settledAttempt = last.status === 'completed' || last.status === 'failed';
    const start = Date.parse(request.startedAt) / 1000;
    const end = request.completedAt ? Date.parse(request.completedAt) / 1000 : undefined;
    Object.assign(first, {
      status: settledAttempt ? last.status : request.status === 'incomplete' ? last.status : request.status === 'suspended' && request.acceptedSubmission ? 'resuming' : request.status,
      inputs: request.resolvedInputs, outputs: request.result ?? last.outputs, description: request.prompt,
      startedAt: Number.isFinite(start) ? start : first.startedAt,
      endedAt: end !== undefined && Number.isFinite(end) ? end : settledAttempt ? last.endedAt : undefined,
      error: request.error ?? last.error,
      sourceEventIndexes: attempts.flatMap(row => row.sourceEventIndexes).sort((a,b) => a-b),
    });
    for (const attempt of attempts.slice(1)) rows.delete(attempt.key);
  }
  const all = [...rows.values()];
  // A durable stop closes outstanding calls without rewriting completed work.
  const boundary = [...events].reverse().find(event => ['run_abort','run_failed','run_complete','run_resume','run_start'].includes(event.event));
  if (boundary?.event === 'run_abort') {
    for (const row of all) if (['running','suspended','resuming'].includes(row.status)) {
      row.status = 'aborted';
      row.endedAt = typeof boundary.ts === 'number' ? boundary.ts : row.endedAt;
    }
  }
  if (includeInternal) return all;
  const visible = all.filter(row => row.kind !== 'assign' || row.status !== 'completed');
  // A computation-only workflow still has a visible result-producing step.
  return visible.length ? visible : all.slice(-1);
}

/** Historical failures remain on their attempts; only the latest boundary can be a current run failure. */
export function currentRunFailure(events: LogEvent[]): LogEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event === 'run_failed' || event.event === 'run_abort') return event;
    if (['run_start', 'run_resume', 'run_complete', 'node_suspended'].includes(event.event)) return undefined;
  }
  return undefined;
}
