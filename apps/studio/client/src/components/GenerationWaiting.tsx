import { useEffect, useState } from 'react';
import { duration } from './AiHealthSummary';

/** Local wait time only: never invent provider progress before receiving telemetry. */
export function GenerationWaiting({ restoring = false, answering = false }: { restoring?: boolean; answering?: boolean }) {
  const [startedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = now - startedAt;
  return <div data-testid="generation-waiting" className="mt-4 w-full max-w-xl rounded-lg border border-blue-300 bg-blue-50/30 p-4 text-left text-sm text-blue-900">
    <div role="status" className="flex items-center gap-2 font-semibold">
      <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full bg-blue-400 motion-safe:animate-pulse" />
      {answering ? 'Sending your answer' : restoring ? 'Loading saved session' : 'Waiting for generation status'}
    </div>
    <div className="mt-3 tabular-nums">Waiting on this page <strong className="text-lg">{duration(elapsed)}</strong></div>
    <p className="mt-2 text-xs leading-relaxed">{answering ? 'Waiting for the server to confirm your answer. You do not need to send it again.' : restoring
      ? 'Reading the saved task. This does not start another AI task.'
      : 'The request is in progress. The server has not returned execution details yet; do not submit it again.'}</p>
    {elapsed >= 30000 && <p role="status" className="mt-2 text-xs text-amber-700">Taking longer than usual. No execution update has arrived; the current stage is unknown.</p>}
  </div>;
}
