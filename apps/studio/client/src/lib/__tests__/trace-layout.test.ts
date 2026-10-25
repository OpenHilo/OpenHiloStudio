import { buildTraceLayout, type CFGNode, type LogEvent, type TraceNode, type TraceContainer } from '../trace-layout';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const simpleNodes: Record<string, CFGNode> = {
  start: { id: 'start', type: 'action', next: 'end' },
  end:   { id: 'end',   type: 'action' },
};

const forNodes: Record<string, CFGNode> = {
  loop: { id: 'loop', type: 'for', next_body: 'body', next_exit: 'done' },
  body: { id: 'body', type: 'action', next: 'loop' },
  done: { id: 'done', type: 'action' },
};

const ifNodes: Record<string, CFGNode> = {
  check: { id: 'check', type: 'if', next_true: 'stepA', next_false: 'stepB' },
  stepA: { id: 'stepA', type: 'action', next: 'join' },
  stepB: { id: 'stepB', type: 'action', next: 'join' },
  join:  { id: 'join',  type: 'action' },
};

const threeIterEvents: LogEvent[] = [
  { event: 'node_pending', node_id: 'loop', node_run_id: 'loop-r1' },
  { event: 'node_success', node_run_id: 'loop-r1' },
  { event: 'node_pending', node_id: 'body', node_run_id: 'body-r1' },
  { event: 'node_success', node_run_id: 'body-r1' },
  { event: 'node_pending', node_id: 'loop', node_run_id: 'loop-r2' },
  { event: 'node_success', node_run_id: 'loop-r2' },
  { event: 'node_pending', node_id: 'body', node_run_id: 'body-r2' },
  { event: 'node_success', node_run_id: 'body-r2' },
  { event: 'node_pending', node_id: 'loop', node_run_id: 'loop-r3' },
  { event: 'node_success', node_run_id: 'loop-r3' },
  { event: 'node_pending', node_id: 'body', node_run_id: 'body-r3' },
  { event: 'node_success', node_run_id: 'body-r3' },
  { event: 'node_pending', node_id: 'done', node_run_id: 'done-r1' },
  { event: 'node_success', node_run_id: 'done-r1' },
];

const oneIterEvents: LogEvent[] = [
  { event: 'node_pending', node_id: 'loop', node_run_id: 'loop-r1' },
  { event: 'node_success', node_run_id: 'loop-r1' },
  { event: 'node_pending', node_id: 'body', node_run_id: 'body-r1' },
  { event: 'node_success', node_run_id: 'body-r1' },
  { event: 'node_pending', node_id: 'done', node_run_id: 'done-r1' },
  { event: 'node_success', node_run_id: 'done-r1' },
];

const ifTrueEvents: LogEvent[] = [
  { event: 'node_pending', node_id: 'check', node_run_id: 'check-r1' },
  { event: 'node_success', node_run_id: 'check-r1' },
  { event: 'node_pending', node_id: 'stepA', node_run_id: 'stepA-r1' },
  { event: 'node_success', node_run_id: 'stepA-r1' },
  { event: 'node_pending', node_id: 'join', node_run_id: 'join-r1' },
  { event: 'node_success', node_run_id: 'join-r1' },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildTraceLayout', () => {
  describe('static CFG mode (empty events)', () => {
    it('returns one TraceNode per CFG node', () => {
      const layout = buildTraceLayout(simpleNodes, 'start', []);
      expect(layout.items).toHaveLength(2);
      expect(layout.items.every(i => i.kind === 'node')).toBe(true);
    });

    it('all nodes are pending and not dimmed', () => {
      const layout = buildTraceLayout(simpleNodes, 'start', []);
      for (const item of layout.items) {
        expect(item.kind).toBe('node');
        expect((item as TraceNode).status).toBe('pending');
        expect((item as TraceNode).dimmed).toBeFalsy();
      }
    });

    it('includes edges', () => {
      const layout = buildTraceLayout(simpleNodes, 'start', []);
      expect(layout.edges.length).toBeGreaterThan(0);
    });
  });

  describe('for loop unrolling', () => {
    it('keeps same-name child loops and assignments out of the root workflow trace', () => {
      const events: LogEvent[] = [
        { event: 'node_pending', node_id: 'loop', node_run_id: 'parent-loop', frame_id: 'parent' },
        { event: 'node_success', node_run_id: 'parent-loop', outputs: { condition_result: true } },
        { event: 'node_pending', node_id: 'body', node_run_id: 'parent-body', frame_id: 'parent' },
        { event: 'frame_push', frame_id: 'child' },
        { event: 'node_pending', node_id: 'loop', node_run_id: 'child-loop', frame_id: 'child' },
        { event: 'node_success', node_run_id: 'child-loop', outputs: { condition_result: true } },
        { event: 'node_pending', node_id: 'body', node_run_id: 'child-body', frame_id: 'child' },
        { event: 'node_success', node_run_id: 'child-body' },
      ];
      const layout = buildTraceLayout(forNodes, 'loop', events);
      expect(layout.items.find(n => n.id === 'loop')).toMatchObject({ kind: 'node', nodeRunId: 'parent-loop' });
      expect(layout.items.find(n => n.id === 'body')).toMatchObject({ nodeRunId: 'parent-body', status: 'running' });
    });

    it.each(['for', 'foreach'])('counts inline continue as a new %s iteration without rendering control-flow sentinels', type => {
      const nodes: Record<string, CFGNode> = {
        loop: { id: 'loop', type, next_body: 'human', next_exit: 'done' },
        human: { id: 'human', type: 'call', executor: 'human', next: 'skip' },
        skip: { id: 'skip', type: 'assign', next: 'CONTINUE' },
        done: { id: 'done', type: 'assign', next: 'END' },
      };
      const events: LogEvent[] = [
        { event: 'node_pending', node_id: 'loop', node_run_id: 'l1', frame_id: 'root' },
        { event: 'node_success', node_run_id: 'l1', outputs: { condition_result: true } },
        { event: 'node_pending', node_id: 'human', node_run_id: 'h1', frame_id: 'root' },
        { event: 'node_success', node_run_id: 'h1' },
        { event: 'node_pending', node_id: 'skip', node_run_id: 's1', frame_id: 'root' },
        { event: 'node_success', node_run_id: 's1' },
        { event: 'continue_inline', trigger_node_run_id: 's1', loop_node_id: 'loop', condition_result: true, next: 'human' },
        { event: 'node_pending', node_id: 'human', node_run_id: 'h2', frame_id: 'root' },
        { event: 'node_success', node_run_id: 'h2' },
        { event: 'node_pending', node_id: 'skip', node_run_id: 's2', frame_id: 'root' },
        { event: 'node_success', node_run_id: 's2' },
        { event: 'continue_inline', trigger_node_run_id: 's2', loop_node_id: 'loop', condition_result: false, next: 'done' },
      ];
      const loop = buildTraceLayout(nodes, 'loop', events).items.find(n => n.id === 'loop') as TraceContainer;
      expect(loop.iterationCount).toBe(2);
      expect(loop.rows.map(row => row.find(n => n.id === 'human')?.nodeRunId)).toEqual(['h1', 'h2']);
      expect(loop.rows.every(row => row.every(n => n.cfg !== undefined))).toBe(true);
      expect(loop.rows[0].map(n => n.id)).toEqual(['human', 'skip']);
    });

    it('does not render BREAK as a node inside a repeated loop', () => {
      const nodes = { ...forNodes, body: { ...forNodes.body, next: 'BREAK' } };
      const loop = buildTraceLayout(nodes, 'loop', threeIterEvents).items.find(n => n.id === 'loop') as TraceContainer;
      expect(loop.rows[0].map(n => n.id)).toEqual(['body']);
    });

    const alternatingNodes: Record<string, CFGNode> = {
      loop: { id: 'loop', type: 'for', next_body: 'human', next_exit: 'done' },
      human: { id: 'human', type: 'call', executor: 'human', next: 'check' },
      check: { id: 'check', type: 'if', next_true: 'finish', next_false: 'more' },
      more: { id: 'more', type: 'action', next: 'loop' },
      finish: { id: 'finish', type: 'action', next: 'END' },
      done: { id: 'done', type: 'action' },
    };
    const resumedLoopEvents: LogEvent[] = [
      { event: 'node_pending', node_id: 'loop', node_run_id: 'l1' },
      { event: 'node_success', node_run_id: 'l1', outputs: { condition_result: true } },
      { event: 'node_pending', node_id: 'human', node_run_id: 'h1-wait' },
      { event: 'node_suspended', node_run_id: 'h1-wait' },
      { event: 'run_resume' },
      { event: 'node_pending', node_id: 'human', node_run_id: 'h1-done' },
      { event: 'node_success', node_run_id: 'h1-done' },
      { event: 'node_pending', node_id: 'more', node_run_id: 'more1' },
      { event: 'node_success', node_run_id: 'more1' },
      { event: 'node_pending', node_id: 'loop', node_run_id: 'l2' },
      { event: 'node_success', node_run_id: 'l2', outputs: { condition_result: true } },
      { event: 'node_pending', node_id: 'human', node_run_id: 'h2' },
      { event: 'node_success', node_run_id: 'h2' },
      { event: 'node_pending', node_id: 'finish', node_run_id: 'finish2' },
      { event: 'node_success', node_run_id: 'finish2' },
    ];

    it('keeps human suspend/resume attempts in their actual loop iteration', () => {
      const layout = buildTraceLayout(alternatingNodes, 'loop', resumedLoopEvents);
      const loop = layout.items.find(i => i.id === 'loop') as TraceContainer;
      expect(loop.rows[0].find(n => n.id === 'human')).toMatchObject({ nodeRunId: 'h1-done', status: 'completed' });
      expect(loop.rows[1].find(n => n.id === 'human')).toMatchObject({ nodeRunId: 'h2', status: 'completed' });
    });

    it('does not move a branch first taken in iteration two into iteration one', () => {
      const layout = buildTraceLayout(alternatingNodes, 'loop', resumedLoopEvents);
      const loop = layout.items.find(i => i.id === 'loop') as TraceContainer;
      expect(loop.rows[0].find(n => n.id === 'finish')).toMatchObject({ nodeRunId: undefined, dimmed: true });
      expect(loop.rows[1].find(n => n.id === 'finish')).toMatchObject({ nodeRunId: 'finish2', status: 'completed' });
      expect(loop.rows[1].find(n => n.id === 'more')).toMatchObject({ nodeRunId: undefined, dimmed: true });
    });

    it.each(['for', 'foreach'])('does not count the final %s exit check as another iteration', type => {
      const events = [...threeIterEvents,
        { event: 'node_pending', node_id: 'loop', node_run_id: 'loop-exit' },
        { event: 'node_success', node_run_id: 'loop-exit', outputs: type === 'foreach' ? { next: 'done' } : { condition_result: false } },
      ];
      const layout = buildTraceLayout({ ...forNodes, loop: { ...forNodes.loop, type } }, 'loop', events);
      const loop = layout.items.find(i => i.id === 'loop') as TraceContainer;
      expect(loop.iterationCount).toBe(3);
    });

    it('keeps an unanswered second-round human node suspended without changing the completed first round', () => {
      const events = resumedLoopEvents.filter(e => e.node_run_id !== 'finish2' && !(e.event === 'node_success' && e.node_run_id === 'h2'));
      events.push({ event: 'node_suspended', node_run_id: 'h2' });
      const loop = buildTraceLayout(alternatingNodes, 'loop', events).items.find(i => i.id === 'loop') as TraceContainer;
      expect(loop.rows[0].find(n => n.id === 'human')?.status).toBe('completed');
      expect(loop.rows[1].find(n => n.id === 'human')?.status).toBe('suspended');
    });

    it('ignores matching body node ids from a different execution frame', () => {
      const events = threeIterEvents.map(e => ({ ...e, frame_id: 'parent' }));
      events.push({ event: 'node_pending', node_id: 'body', node_run_id: 'foreign', frame_id: 'child' });
      const loop = buildTraceLayout(forNodes, 'loop', events).items.find(i => i.id === 'loop') as TraceContainer;
      expect(loop.rows[2][0].nodeRunId).toBe('body-r3');
    });

    it('for with 3 executions → TraceContainer', () => {
      const layout = buildTraceLayout(forNodes, 'loop', threeIterEvents);
      const loop = layout.items.find(i => i.id === 'loop');
      expect(loop?.kind).toBe('container');
    });

    it('container has 3 rows', () => {
      const layout = buildTraceLayout(forNodes, 'loop', threeIterEvents);
      const container = layout.items.find(i => i.id === 'loop') as TraceContainer;
      expect(container.iterationCount).toBe(3);
      expect(container.rows).toHaveLength(3);
    });

    it('each row contains the body node', () => {
      const layout = buildTraceLayout(forNodes, 'loop', threeIterEvents);
      const container = layout.items.find(i => i.id === 'loop') as TraceContainer;
      for (const row of container.rows) {
        expect(row).toHaveLength(1);
        expect(row[0].id).toBe('body');
      }
    });

    it('each row node carries its nodeRunId', () => {
      const layout = buildTraceLayout(forNodes, 'loop', threeIterEvents);
      const container = layout.items.find(i => i.id === 'loop') as TraceContainer;
      expect(container.rows[0][0].nodeRunId).toBe('body-r1');
      expect(container.rows[1][0].nodeRunId).toBe('body-r2');
      expect(container.rows[2][0].nodeRunId).toBe('body-r3');
    });

    it('body node does NOT appear as top-level item', () => {
      const layout = buildTraceLayout(forNodes, 'loop', threeIterEvents);
      expect(layout.items.find(i => i.id === 'body' && i.kind === 'node')).toBeUndefined();
    });

    it('done node appears as top-level TraceNode', () => {
      const layout = buildTraceLayout(forNodes, 'loop', threeIterEvents);
      const done = layout.items.find(i => i.id === 'done');
      expect(done?.kind).toBe('node');
    });

    it('for with 1 execution → TraceNode (not container)', () => {
      const layout = buildTraceLayout(forNodes, 'loop', oneIterEvents);
      const loop = layout.items.find(i => i.id === 'loop');
      expect(loop?.kind).toBe('node');
    });

    it('for with 0 executions → TraceNode', () => {
      const layout = buildTraceLayout(forNodes, 'loop', []);
      const loop = layout.items.find(i => i.id === 'loop');
      expect(loop?.kind).toBe('node');
    });
  });

  describe('if branch dimming', () => {
    it('if took true → false-branch node is dimmed', () => {
      const layout = buildTraceLayout(ifNodes, 'check', ifTrueEvents);
      const stepB = layout.items.find(i => i.id === 'stepB') as TraceNode;
      expect(stepB.dimmed).toBe(true);
    });

    it('if took true → true-branch node is NOT dimmed', () => {
      const layout = buildTraceLayout(ifNodes, 'check', ifTrueEvents);
      const stepA = layout.items.find(i => i.id === 'stepA') as TraceNode;
      expect(stepA.dimmed).toBeFalsy();
    });

    it('convergence node (join) is NOT dimmed', () => {
      const layout = buildTraceLayout(ifNodes, 'check', ifTrueEvents);
      const join = layout.items.find(i => i.id === 'join') as TraceNode;
      expect(join.dimmed).toBeFalsy();
    });

    it('false-branch edge is dimmed', () => {
      const layout = buildTraceLayout(ifNodes, 'check', ifTrueEvents);
      const falseEdge = layout.edges.find(e => e.from === 'check' && e.kind === 'next_false');
      expect(falseEdge?.dimmed).toBe(true);
    });

    it('true-branch edge is NOT dimmed', () => {
      const layout = buildTraceLayout(ifNodes, 'check', ifTrueEvents);
      const trueEdge = layout.edges.find(e => e.from === 'check' && e.kind === 'next_true');
      expect(trueEdge?.dimmed).toBeFalsy();
    });
  });

  describe('layout positions', () => {
    it('all items have valid positive positions', () => {
      const layout = buildTraceLayout(simpleNodes, 'start', []);
      for (const item of layout.items) {
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.y).toBeGreaterThanOrEqual(0);
        expect(item.w).toBeGreaterThan(0);
        expect(item.h).toBeGreaterThan(0);
      }
    });

    it('entry node has smaller y than downstream nodes', () => {
      const layout = buildTraceLayout(simpleNodes, 'start', []);
      const startItem = layout.items.find(i => i.id === 'start')!;
      const endItem = layout.items.find(i => i.id === 'end')!;
      expect(startItem.y).toBeLessThan(endItem.y);
    });
  });

  describe('error handling', () => {
    it('never throws — falls back gracefully on malformed input', () => {
      expect(() => buildTraceLayout({}, 'missing', [])).not.toThrow();
    });
  });
});
