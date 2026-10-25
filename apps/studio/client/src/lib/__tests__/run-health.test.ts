import { currentRunAiHealth, describeAiHealth, type AiHealth } from '../../api/aiHealth';

test('active budget freezes while waiting and resumes without claiming completion', () => {
  const now = Date.parse('2026-10-08T15:00:00Z');
  const health: AiHealth = { phase: 'waiting_for_input', condition: 'active', elapsedMs: 1000,
    idleMs: 1000, phaseElapsedMs: 1000, activeTools: 0, observedAt: new Date(now).toISOString(), heartbeatMs: 5000,
    activeElapsedMs: 500, remainingMs: 60_000 };
  expect(describeAiHealth(health, now)).toMatchObject({ remainingMs: 60_000, condition: 'Human input needed', stale: false });
  expect(describeAiHealth(health, now + 65_000)).toMatchObject({ remainingMs: 60_000, elapsedMs: 500, condition: 'Status stale', label: 'Last known: Waiting for your answer', stale: true });
  expect(describeAiHealth({...health, phase: 'model'}, now + 1000)).toMatchObject({remainingMs: 59000, elapsedMs: 1500});
  expect(describeAiHealth({...health, phase: 'model'}, now + 65000)).toMatchObject({remainingMs: 0});
  expect(describeAiHealth({ ...health, remainingMs: undefined, deadlineAt: undefined }, now).remainingMs).toBeNull();
  expect(describeAiHealth({ ...health, remainingMs: undefined, deadlineAt: 'invalid' }, now).remainingMs).toBeNull();
});

test('expired or invalid observation timestamps never retain an Active headline', () => {
  const now = Date.parse('2026-10-11T11:00:00Z');
  const health: AiHealth = { phase: 'model', condition: 'active', elapsedMs: 1000,
    idleMs: 1000, phaseElapsedMs: 1000, activeTools: 0, observedAt: new Date(now - 16000).toISOString(), heartbeatMs: 1000 };
  expect(describeAiHealth(health, now)).toMatchObject({ condition: 'Status stale', label: 'Last known: Waiting for model', stale: true });
  expect(describeAiHealth({ ...health, observedAt: 'invalid' }, now)).toMatchObject({ condition: 'Status stale', stale: true });
  expect(describeAiHealth({ ...health, observedAt: new Date(now).toISOString() }, now)).toMatchObject({ condition: 'Active', label: 'Waiting for model', stale: false });
});

test('authoritative terminal or stopping status suppresses a stale active heartbeat, even without a final log event', () => {
  const events = [{ event: 'ai_health', node_run_id: 'ai-1', health: { phase: 'model', condition: 'active' } }];
  expect(currentRunAiHealth(events, 'running').size).toBe(1);
  for (const status of ['completed', 'failed', 'aborted', 'stopping']) {
    expect(currentRunAiHealth(events, status).size).toBe(0);
  }
});
