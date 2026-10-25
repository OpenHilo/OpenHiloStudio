import type {CFGNode, LogEvent} from './trace-layout';
const edgeKeys = ['next', 'next_true', 'next_false', 'next_body', 'next_exit'] as const;
/** Collapse only linear bookkeeping. Cycles, unknown nodes and failed work remain inspectable. */
export function projectWorkflow(nodes: Record<string, CFGNode>, entry: string, events: LogEvent[], mode: 'workflow' | 'technical') {
  if (mode === 'technical') return {nodes, entry, hiddenNodeIds: [] as string[], warnings: [] as string[]};
  const protectedIds = new Set<string>();
  const pending = new Map<string, LogEvent>();
  const terminal = new Set(events.filter(e => e.event === 'node_success' || e.event === 'node_failed').map(e => e.node_run_id));
  const rootFrame = events.find(e => e.event === 'node_pending')?.frame_id;
  for (const e of events) {
    if (e.event === 'node_pending' && e.node_run_id) {
      pending.set(e.node_run_id,e);
      if (e.frame_id === rootFrame && e.node_id && !terminal.has(e.node_run_id)) protectedIds.add(e.node_id);
    }
    if (e.event === 'node_failed' && e.node_run_id) {
      const p = pending.get(e.node_run_id);
      if (p && p.frame_id === rootFrame && p.node_id) protectedIds.add(p.node_id);
    }
  }
  const collapsible = (id: string) => nodes[id]?.type === 'assign' && !!nodes[id].next && !protectedIds.has(id) && !edgeKeys.slice(1).some(key => nodes[id][key]);
  const resolve = (start: string): string => {
    const seen = new Set<string>();
    let id = start;
    while (collapsible(id)) {
      if (seen.has(id)) return start;
      seen.add(id); id = nodes[id].next!;
    }
    return id;
  };
  const hidden = Object.keys(nodes).filter(id => collapsible(id) && resolve(id) !== id);
  // Keep the entry of a data-only workflow rather than presenting an empty graph.
  if (hidden.length === Object.keys(nodes).length) hidden.splice(hidden.indexOf(entry), 1);
  const hiddenSet = new Set(hidden);
  const kept: Record<string, CFGNode> = {};
  const destination = (id: string) => hiddenSet.has(id) ? resolve(id) : id;
  for (const [id, node] of Object.entries(nodes)) {
    if (hiddenSet.has(id)) continue;
    const copy = {...node};
    for (const key of edgeKeys) if (copy[key]) copy[key] = destination(copy[key]!);
    kept[id] = copy;
  }
  return {nodes:kept, entry:destination(entry), hiddenNodeIds:hidden, warnings:[] as string[]};
}

import type { IntentDetail } from '../api/namespaces';
export function filterWorkflowMetadata<T extends Pick<IntentDetail, 'facet' | 'tags'>>(intents: T[], facet: string, tags: Record<string, string>): T[] {
  return intents.filter(intent => (!facet || intent.facet === facet) && Object.entries(tags).every(([key,value]) => !value || intent.tags?.[key] === value));
}
