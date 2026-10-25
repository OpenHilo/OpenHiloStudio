import { useState, useEffect } from 'react';
import { getStats, type DashboardStats } from '../api/stats';

export function useStats(intervalMs = 3000) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true, busy = false;
    const controller = new AbortController();
    setLoading(true); setError(null);
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const result = await getStats(controller.signal);
        if (active) { setStats(result); setError(null); }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Unable to load dashboard statistics.');
      } finally { busy = false; if (active) setLoading(false); }
    }
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => { active = false; clearInterval(timer); controller.abort(); };
  }, [intervalMs, revision]);
  return { stats, error, loading, refresh: () => setRevision(value => value + 1) };
}
