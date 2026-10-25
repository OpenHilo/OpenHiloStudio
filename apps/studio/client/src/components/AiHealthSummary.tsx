import { useEffect, useState } from 'react';
import { describeAiHealth, type AiHealth } from '../api/aiHealth';

export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function AiHealthSummary({ health, label, dark = false }: { health: AiHealth; label?: string; dark?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const status = describeAiHealth(health, now);
  const color = status.warning
    ? dark ? 'border-amber-300 text-amber-700' : 'border-amber-300 text-amber-800'
    : dark ? 'border-gray-200 text-gray-600' : 'border-gray-300 text-gray-700';
  const explanation = status.stale ? 'Connection status is unknown. The task may still be running; do not submit it again.'
    : health.phase === 'stopping' ? 'A stop was requested. Waiting for the executor to finish cleanup.'
    : health.condition === 'stalled' ? 'No recent execution activity. The task may be stalled; completion has not been confirmed.'
    : health.phase === 'waiting_for_input' ? 'Your answer is needed to continue. The AI execution timer is paused while waiting for you.'
    : health.condition === 'slow' ? 'This step is taking longer than usual. The executor is still sending status updates.'
    : health.phase === 'tool' ? 'The AI is using tools. Results will appear when this step finishes.'
    : health.phase === 'cleanup' ? 'The executor is finishing cleanup before reporting its result.'
    : health.phase === 'starting' ? 'Connecting to the AI executor.'
    : 'Waiting for the next model response. Status updates do not guarantee model progress.';
  return (
    <div data-testid="ai-health" className={`w-full max-w-xl rounded-lg border p-4 text-left text-sm ${color}`}>
      <div role="status" className="font-semibold">
        {label ? `${label} · ` : ''}{status.label} · {status.condition}
        {health.phase === 'stopping' && ` (${health.stopReason === 'timeout' ? 'timeout' : 'cancellation'} requested; awaiting settlement)`}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 tabular-nums">
        <span>AI execution time <strong className="text-lg">{duration(status.elapsedMs)}</strong></span>
        <span>Last activity {duration(status.idleMs)} ago</span>
        {health.activeTools > 0 && ` · ${health.activeTools} ${status.stale ? 'last reported active' : 'active'} tool${health.activeTools === 1 ? '' : 's'}`}
      </div>
      <p className="mt-2 text-xs leading-relaxed">{explanation}</p>
      {status.remainingMs !== null && <p className="mt-2 text-xs">{status.remainingMs > 0
        ? <>AI time remaining: <strong>{duration(status.remainingMs)}</strong> (excludes time waiting for answers).</>
        : 'The attempt deadline has passed. Waiting for the server to confirm the outcome; do not submit it again.'}</p>}
      <div className="mt-2 text-xs opacity-75">Last status update: {status.heartbeatAgeMs === null ? 'unknown' : `${duration(status.heartbeatAgeMs)} ago`}</div>
      {(health.stalledTools?.length ?? 0) > 0 && (
        <div className="mt-1">
          Tools with no completion reported:
          <ul className="list-disc pl-4">
            {health.stalledTools!.map(tool => <li key={tool.callId}>{tool.tool} ({tool.callId}) · {duration(tool.elapsedMs)}</li>)}
          </ul>
        </div>
      )}
      {status.stale && <div role="status" className="mt-1 font-medium">No recent heartbeat — current AI state is unknown.</div>}
    </div>
  );
}
