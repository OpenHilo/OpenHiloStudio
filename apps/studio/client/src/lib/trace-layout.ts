export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'suspended';

export interface CFGNode {
  id: string;
  type: string;
  next?: string;
  next_true?: string;
  next_false?: string;
  next_body?: string;
  next_exit?: string;
  executor?: string;
  [key: string]: unknown;
}

export interface LogEvent {
  event: string;
  node_id?: string;
  node_run_id?: string;
  [key: string]: unknown;
}

export interface TraceNode {
  kind: 'node';
  id: string;
  nodeRunId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  status: NodeStatus;
  error?: string;
  dimmed?: boolean;
  cfg: CFGNode;
}

export interface TraceContainer {
  kind: 'container';
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  iterationCount: number;
  collapsed: boolean;
  rows: TraceNode[][];
  cfg: CFGNode;
}

export interface TraceEdge {
  from: string;
  to: string;
  kind: 'next' | 'next_true' | 'next_false' | 'next_exit' | 'next_body';
  dimmed?: boolean;
  points?: {x:number;y:number}[];
  label?: {text:string;x:number;y:number;width:number;height:number};
}

export interface TraceLayout {
  routed?: boolean;
  items: (TraceNode | TraceContainer)[];
  edges: TraceEdge[];
  width: number;
  height: number;
}

// Layout constants — exported so IttFlowchart can use them for rendering
export const NODE_W = 120;
export const NODE_H = 36;
export const H_GAP = 60;
export const V_GAP = 40;
export const CONTAINER_PADDING = 12;
export const ROW_H = NODE_H + 20;
export const CONTAINER_HEADER_H = 32;
export const CANVAS_PAD = 20;

// ── Internal helpers ──────────────────────────────────────────────────────────

function getNextIds(node: CFGNode): string[] {
  const ids: string[] = [];
  if (node.next       && node.next       !== 'END') ids.push(node.next);
  if (node.next_true  && node.next_true  !== 'END') ids.push(node.next_true);
  if (node.next_false && node.next_false !== 'END') ids.push(node.next_false);
  if (node.next_body  && node.next_body  !== 'END') ids.push(node.next_body);
  if (node.next_exit  && node.next_exit  !== 'END') ids.push(node.next_exit);
  return ids;
}

// Phase 1 ─────────────────────────────────────────────────────────────────────

/** The displayed CFG is the entry workflow. Child frames can reuse every node
 * ID, so attach execution data by frame and run ID, never by node name alone.
 * Older logs without frame IDs retain their existing single-workflow behavior.
 */
function rootFrameEvents(events: LogEvent[]): LogEvent[] {
  const rootFrame = events.find(event => event.event === 'node_pending')?.frame_id;
  if (typeof rootFrame !== 'string') return events;
  const runIds = new Set(events.filter(event => event.event === 'node_pending' && event.frame_id === rootFrame)
    .map(event => event.node_run_id));
  return events.filter(event => {
    if (event.node_run_id) return runIds.has(event.node_run_id);
    if (typeof event.trigger_node_run_id === 'string') return runIds.has(event.trigger_node_run_id);
    return event.frame_id === undefined || event.frame_id === rootFrame;
  });
}

function parseEvents(events: LogEvent[]): {
  nodeRunMap: Map<string, string[]>;
  statusMap:  Map<string, NodeStatus>;
  errorMap:   Map<string, string>;
} {
  const nodeRunMap = new Map<string, string[]>();
  const statusMap  = new Map<string, NodeStatus>();
  const errorMap   = new Map<string, string>();

  for (const ev of events) {
    if (ev.event === 'node_pending' && ev.node_id && ev.node_run_id) {
      const runs = nodeRunMap.get(ev.node_id) ?? [];
      runs.push(ev.node_run_id);
      nodeRunMap.set(ev.node_id, runs);
      statusMap.set(ev.node_run_id, 'running');
    }
  }
  for (const ev of events) {
    if (!ev.node_run_id) continue;
    if (ev.event === 'node_success')   statusMap.set(ev.node_run_id, 'completed');
    if (ev.event === 'node_failed') {
      statusMap.set(ev.node_run_id, 'failed');
      if (ev.error) errorMap.set(ev.node_run_id, String(ev.error));
    }
    if (ev.event === 'node_suspended') statusMap.set(ev.node_run_id, 'suspended');
  }
  return { nodeRunMap, statusMap, errorMap };
}

// Phase 2 ─────────────────────────────────────────────────────────────────────

/** Returns the set of CFG node IDs that live inside the loop body of forId. */
function collectLoopBody(nodes: Record<string, CFGNode>, forId: string): string[] {
  const forNode = nodes[forId];
  if (!forNode?.next_body || forNode.next_body === 'END') return [];

  const body: string[] = [];
  const visited = new Set<string>();
  const queue = [forNode.next_body];

  while (queue.length > 0) {
    const id = queue.shift()!;
    // Stop at: already visited, the for node itself, END, or the loop's exit node
    if (visited.has(id) || id === forId || id === 'END' || id === forNode.next_exit || !nodes[id]) continue;
    visited.add(id);
    body.push(id);
    const node = nodes[id];
    if (!node) continue;
    for (const nextId of getNextIds(node)) {
      if (!visited.has(nextId)) queue.push(nextId);
    }
  }
  return body;
}

/** Group executions by loop entry, not by each body's occurrence count.
 * Human resume creates a new attempt in the same iteration, while a branch
 * may be skipped entirely. Keep the latest attempt within each frame/entry.
 */
function collectLoopIterations(nodes: Record<string, CFGNode>, forId: string, events: LogEvent[]): Map<string, string>[] {
  const body = new Set(collectLoopBody(nodes, forId));
  const iterations = new Map<string, Map<string, string>>();
  const activeByFrame = new Map<unknown, Map<string, string>>();
  const frameByRun = new Map<string, unknown>();
  const exits = new Set<string>();
  for (const event of events) {
    if (event.event === 'node_pending' && event.node_run_id) {
      frameByRun.set(event.node_run_id, event.frame_id);
      if (event.node_id === forId) {
        let iteration = iterations.get(event.node_run_id);
        if (!iteration) {
          iteration = new Map();
          iterations.set(event.node_run_id, iteration);
        }
        activeByFrame.set(event.frame_id, iteration);
      } else if (event.node_id && body.has(event.node_id)) {
        activeByFrame.get(event.frame_id)?.set(event.node_id, event.node_run_id);
      }
    }
    // continue advances the loop inline: it has no second loop node_pending.
    if (event.event === 'continue_inline' && event.loop_node_id === forId && event.condition_result === true &&
        typeof event.trigger_node_run_id === 'string' && frameByRun.has(event.trigger_node_run_id)) {
      const iteration = new Map<string, string>();
      iterations.set(`continue:${event.trigger_node_run_id}`, iteration);
      activeByFrame.set(frameByRun.get(event.trigger_node_run_id), iteration);
    }
    if (event.event === 'node_success' && event.node_run_id && iterations.has(event.node_run_id)) {
      const output = event.outputs as { condition_result?: boolean; next?: string } | undefined;
      if (output?.condition_result === false || (output?.next !== undefined && output.next === nodes[forId].next_exit)) {
        exits.add(event.node_run_id);
      }
    }
  }
  return [...iterations].filter(([runId]) => !exits.has(runId)).map(([, iteration]) => iteration);
}

/**
 * For each if node that has execution data, records which branch was taken.
 * 'both' means both branches were executed at some point (e.g. loop containing an if).
 */
function buildBranchMap(
  nodes: Record<string, CFGNode>,
  nodeRunMap: Map<string, string[]>,
): Map<string, 'true' | 'false' | 'both'> {
  const branchMap = new Map<string, 'true' | 'false' | 'both'>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== 'if') continue;
    const trueTaken  = !!(node.next_true  && node.next_true  !== 'END' && (nodeRunMap.get(node.next_true)?.length  ?? 0) > 0);
    const falseTaken = !!(node.next_false && node.next_false !== 'END' && (nodeRunMap.get(node.next_false)?.length ?? 0) > 0);
    if (trueTaken && falseTaken) branchMap.set(id, 'both');
    else if (trueTaken)          branchMap.set(id, 'true');
    else if (falseTaken)         branchMap.set(id, 'false');
  }
  return branchMap;
}

/**
 * BFS from the first node of each untaken branch.
 * Stops at nodes that were actually executed (convergence point) — those are NOT dimmed.
 */
function buildDimmedSet(
  nodes: Record<string, CFGNode>,
  branchMap: Map<string, 'true' | 'false' | 'both'>,
  nodeRunMap: Map<string, string[]>,
): Set<string> {
  const dimmed = new Set<string>();
  for (const [ifId, taken] of branchMap) {
    if (taken === 'both') continue;
    const ifNode = nodes[ifId];
    if (!ifNode) continue;
    const untakenStart = taken === 'true' ? ifNode.next_false : ifNode.next_true;
    if (!untakenStart || untakenStart === 'END') continue;

    const queue   = [untakenStart];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id) || id === 'END') continue;
      // Convergence: this node was executed — stop here, do NOT dim it
      if ((nodeRunMap.get(id)?.length ?? 0) > 0) continue;
      visited.add(id);
      dimmed.add(id);
      const node = nodes[id];
      if (!node) continue;
      for (const nextId of getNextIds(node)) {
        if (!visited.has(nextId)) queue.push(nextId);
      }
    }
  }
  return dimmed;
}

export function buildTraceLayout(
  nodes: Record<string, CFGNode>,
  entry: string,
  events: LogEvent[] = []
): TraceLayout {
  try {
    return _buildTraceLayout(nodes, entry, events);
  } catch {
    // Worst case: fall back to static CFG (no dimming, no containers)
    try { return _buildTraceLayout(nodes, entry, []); } catch { /* ignore */ }
    return { items: [], edges: [], width: 200, height: 200 };
  }
}

function _buildTraceLayout(
  nodes: Record<string, CFGNode>,
  entry: string,
  events: LogEvent[],
): TraceLayout {
  events = rootFrameEvents(events);
  const { nodeRunMap, statusMap, errorMap } = parseEvents(events);
  const branchMap = buildBranchMap(nodes, nodeRunMap);
  const dimmedSet = buildDimmedSet(nodes, branchMap, nodeRunMap);

  // Identify container nodes (for/foreach executed more than once)
  const containerIds = new Set<string>();
  const bodyNodeIds  = new Set<string>();
  const loopIterations = new Map<string, Map<string, string>[]>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type === 'for' || node.type === 'foreach') {
      const iterations = collectLoopIterations(nodes, id, events);
      loopIterations.set(id, iterations);
      if (iterations.length > 1) {
        containerIds.add(id);
        for (const bodyId of collectLoopBody(nodes, id)) bodyNodeIds.add(bodyId);
      }
    }
  }

  // Helper: width of an outer item (container wider than NODE_W)
  function itemWidth(id: string): number {
    if (!containerIds.has(id)) return NODE_W;
    const bodyIds = collectLoopBody(nodes, id);
    const bodyW = bodyIds.length * NODE_W + Math.max(0, bodyIds.length - 1) * H_GAP;
    return Math.max(NODE_W, bodyW) + 2 * CONTAINER_PADDING;
  }

  // Helper: height of an outer item
  function itemHeight(id: string): number {
    if (!containerIds.has(id)) return NODE_H;
    const runCount = loopIterations.get(id)?.length ?? 0;
    return CONTAINER_HEADER_H + runCount * ROW_H + CONTAINER_PADDING;
  }

  // ── BFS layer assignment (outer nodes only; body nodes excluded) ────────────
  const layers: Record<string, number> = {};
  if (entry in nodes) layers[entry] = 0;
  const queue   = entry in nodes ? [entry] : [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id) || bodyNodeIds.has(id)) continue;
    visited.add(id);
    const node = nodes[id];
    if (!node) continue;
    const currentLayer = layers[id] ?? 0;

    // Edges to follow at the outer level
    const nextOuter: string[] = [];
    if (containerIds.has(id)) {
      // Container: follow next_exit only (body is internal)
      if (node.next_exit && node.next_exit !== 'END') nextOuter.push(node.next_exit);
    } else {
      for (const nextId of getNextIds(node)) {
        if (nextId in nodes && !bodyNodeIds.has(nextId)) nextOuter.push(nextId);
      }
    }

    for (const nextId of nextOuter) {
      layers[nextId] = Math.max(layers[nextId] ?? 0, currentLayer + 1);
      if (!visited.has(nextId)) queue.push(nextId);
    }
  }

  // Group outer nodes by layer
  const byLayer: Record<number, string[]> = {};
  for (const [id, layer] of Object.entries(layers)) {
    (byLayer[layer] = byLayer[layer] ?? []).push(id);
  }

  // Canvas width: wide enough for the widest layer
  let canvasW = CANVAS_PAD * 2 + NODE_W;
  for (const ids of Object.values(byLayer)) {
    const layerW = ids.reduce((sum, id, i) =>
      sum + itemWidth(id) + (i < ids.length - 1 ? H_GAP : 0), 0);
    canvasW = Math.max(canvasW, layerW + CANVAS_PAD * 2);
  }

  // ── Assign (x, y) positions ───────────────────────────────────────────────
  const positions: Record<string, { x: number; y: number }> = {};
  const maxLayer = Math.max(0, ...Object.keys(byLayer).map(Number));
  let currentY = CANVAS_PAD;

  for (let layer = 0; layer <= maxLayer; layer++) {
    const ids = byLayer[layer] ?? [];
    const widths = ids.map(itemWidth);
    const totalW = widths.reduce((s, w, i) => s + w + (i < widths.length - 1 ? H_GAP : 0), 0);
    let x = (canvasW - totalW) / 2;

    ids.forEach((id, i) => {
      positions[id] = { x, y: currentY };
      x += widths[i] + H_GAP;
    });

    const layerH = Math.max(...ids.map(itemHeight), NODE_H);
    currentY += layerH + V_GAP;
  }

  // ── Build items ───────────────────────────────────────────────────────────
  const items: (TraceNode | TraceContainer)[] = [];

  for (const [id, pos] of Object.entries(positions)) {
    const node = nodes[id];
    if (!node) continue;

    if (containerIds.has(id)) {
      const runs    = loopIterations.get(id) ?? [];
      const bodyIds = collectLoopBody(nodes, id);
      const rows: TraceNode[][] = runs.map((iteration, iterIdx) =>
        bodyIds.map((bodyId, bodyIdx): TraceNode => {
          const bodyNode  = nodes[bodyId];
          const bodyRunId = iteration.get(bodyId);
          const bodyStatus: NodeStatus = bodyRunId ? (statusMap.get(bodyRunId) ?? 'pending') : 'pending';
          return {
            kind: 'node',
            id: bodyId,
            nodeRunId: bodyRunId,
            x: bodyIdx * (NODE_W + H_GAP),  // relative to container interior
            y: iterIdx * ROW_H,              // relative to container interior
            w: NODE_W,
            h: NODE_H,
            status: bodyStatus,
            error: bodyRunId ? errorMap.get(bodyRunId) : undefined,
            dimmed: !bodyRunId,
            cfg: bodyNode,
          };
        })
      );

      const bodyW = bodyIds.length * NODE_W + Math.max(0, bodyIds.length - 1) * H_GAP;
      const containerW = Math.max(NODE_W, bodyW) + 2 * CONTAINER_PADDING;
      const containerH = CONTAINER_HEADER_H + runs.length * ROW_H + CONTAINER_PADDING;

      items.push({
        kind: 'container',
        id,
        x: pos.x,
        y: pos.y,
        w: containerW,
        h: containerH,
        label: id,
        iterationCount: runs.length,
        collapsed: false,
        rows,
        cfg: node,
      } satisfies TraceContainer);
    } else {
      const runs   = nodeRunMap.get(id) ?? [];
      // Use the last run — for human nodes that suspend+resume, the second run is the completed one
      const runId  = runs[runs.length - 1];
      const status: NodeStatus = runId ? (statusMap.get(runId) ?? 'pending') : 'pending';
      items.push({
        kind: 'node',
        id,
        nodeRunId: runId,
        x: pos.x,
        y: pos.y,
        w: NODE_W,
        h: NODE_H,
        status,
        error: runId ? errorMap.get(runId) : undefined,
        dimmed: dimmedSet.has(id),
        cfg: node,
      } satisfies TraceNode);
    }
  }

  // ── Build edges ────────────────────────────────────────────────────────────
  const edges: TraceEdge[] = [];

  for (const [id, node] of Object.entries(nodes)) {
    if (bodyNodeIds.has(id)) continue;  // internal container edges not shown

    if (containerIds.has(id)) {
      // Container exposes only next_exit edge
      if (node.next_exit && node.next_exit !== 'END' && positions[node.next_exit]) {
        edges.push({ from: id, to: node.next_exit, kind: 'next_exit' });
      }
    } else {
      if (node.next       && node.next       !== 'END' && positions[node.next])       edges.push({ from: id, to: node.next,       kind: 'next' });
      if (node.next_true  && node.next_true  !== 'END' && positions[node.next_true])  edges.push({ from: id, to: node.next_true,  kind: 'next_true',  dimmed: dimmedSet.has(node.next_true) });
      if (node.next_false && node.next_false !== 'END' && positions[node.next_false]) edges.push({ from: id, to: node.next_false, kind: 'next_false', dimmed: dimmedSet.has(node.next_false) });
      if (node.next_exit  && node.next_exit  !== 'END' && positions[node.next_exit])  edges.push({ from: id, to: node.next_exit,  kind: 'next_exit' });
      // next_body edges suppressed — superseded by swimlane rows
    }
  }

  return { items, edges, width: canvasW, height: currentY };
}
