// platform/client/src/hooks/useHumanHistory.ts
import { useEffect, useState } from 'react';
import { getHumanHistory, type HumanHistoryItem } from '../api/human';

export function useHumanHistory(runId: string, runStatus: string) {
  const [history, setHistory] = useState<HumanHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let active: AbortController | undefined;
    if (!runId) { setHistory([]); setError(null); return; }
    async function refresh() {
      active = new AbortController();
      const deadline = setTimeout(() => active?.abort(), 15000);
      let failed = false;
      try {
        const next = await getHumanHistory(runId, active.signal);
        if (!cancelled) { setHistory(next); setError(null); }
      } catch (failure) {
        failed = true;
        if (!cancelled) setError(`Unable to refresh human tasks: ${active.signal.aborted ? 'request timed out' : (failure as Error).message}. Retrying…`);
      } finally {
        clearTimeout(deadline);
        // Consecutive human nodes can suspend again before status polling ever
        // sees "running". Refresh task identities even when runStatus is unchanged.
        if (!cancelled && (failed || runStatus === 'running' || runStatus === 'suspended')) timer = setTimeout(refresh, 2000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); active?.abort(); };
  }, [runId, runStatus]);

  useEffect(() => { setHistory([]); setError(null); }, [runId]);
  return { history, error };
}
