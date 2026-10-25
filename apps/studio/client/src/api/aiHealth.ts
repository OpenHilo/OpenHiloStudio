// JSON health contract shared by run events and generation responses.
// Keep this browser-only shape in sync with @openhilo/ai-contracts ExecutionHealth.
export interface AiHealth {
  phase: 'starting' | 'model' | 'tool' | 'waiting_for_input' | 'cleanup' | 'stopping';
  condition: 'active' | 'slow' | 'stalled';
  elapsedMs: number;
  idleMs: number;
  phaseElapsedMs: number;
  activeTools: number;
  stalledTools?: { callId: string; tool: string; elapsedMs: number }[];
  observedAt: string;
  heartbeatMs: number;
  deadlineAt?: string;
  activeElapsedMs?: number;
  remainingMs?: number;
  stopReason?: 'cancelled' | 'timeout';
}

export function describeAiHealth(health: AiHealth, now: number) {
  const age = Math.max(0, now - Date.parse(health.observedAt));
  const stale = !Number.isFinite(age) || age > Math.max(3 * health.heartbeatMs, 15_000);
  const phases: Record<AiHealth['phase'], string> = {
    starting: 'Starting AI', model: 'Waiting for model', tool: 'Running tools',
    waiting_for_input: 'Waiting for your answer', cleanup: 'Cleaning up', stopping: 'Stopping AI',
  };
  const waiting = health.phase === 'waiting_for_input';
  const deadline = health.deadlineAt ? Date.parse(health.deadlineAt) : NaN;
  const ticking = !waiting && health.phase !== 'stopping';
  const activeAge = ticking && Number.isFinite(age) ? age : 0;
  const remainingMs = health.remainingMs !== undefined ? Math.max(0, health.remainingMs - activeAge)
    : Number.isFinite(deadline) ? Math.max(0, deadline - (waiting ? Date.parse(health.observedAt) : now)) : null;
  const condition = stale ? 'Status stale' : health.condition === 'stalled' ? 'Stalled'
    : health.condition === 'slow' ? 'Slow' : waiting ? 'Human input needed' : 'Active';
  return {
    label: stale ? `Last known: ${phases[health.phase]}` : phases[health.phase], condition, stale, remainingMs,
    warning: stale || health.condition !== 'active',
    elapsedMs: health.activeElapsedMs !== undefined ? health.activeElapsedMs + activeAge : health.elapsedMs + (Number.isFinite(age) ? age : 0),
    idleMs: health.idleMs + (Number.isFinite(age) ? age : 0),
    heartbeatAgeMs: Number.isFinite(age) ? age : null,
  };
}

/** Heartbeats are current state, not individual log rows. Transport closure is not completion. */
export function currentRunAiHealth(events: ReadonlyArray<Record<string, unknown>>, runStatus?: string) {
  const current = new Map<string, AiHealth>();
  if (runStatus && ['completed', 'failed', 'aborted', 'stopping'].includes(runStatus)) return current;
  for (const event of events) {
    if (event.event === 'ai_health' && event.node_run_id && event.health) {
      current.set(String(event.node_run_id), event.health as AiHealth);
    } else if (['node_success', 'node_failed', 'node_suspended'].includes(String(event.event))) {
      current.delete(String(event.node_run_id));
    } else if (['run_complete', 'run_failed', 'run_abort'].includes(String(event.event))) {
      current.clear();
    }
  }
  return current;
}
