// platform/client/src/hooks/useRuns.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { listRuns, type ListRunsResponse } from '../api/runs';

interface UseRunsOpts { filters?: Record<string, string>; limit?: number; enabled?: boolean; page?: number; onPageChange?: (page: number) => void; }

export function useRuns(opts: UseRunsOpts = {}) {
  const [localPage, setLocalPage] = useState(1);
  const page = opts.page ?? localPage;
  const setPage = opts.onPageChange ?? setLocalPage;
  const [data, setData] = useState<ListRunsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  const enabled = opts.enabled !== false;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Serialize filters so changes trigger a re-fetch; also reset page to 1
  const filtersJson = JSON.stringify(opts.filters ?? {});
  const prevFiltersJson = useRef(filtersJson);
  if (prevFiltersJson.current !== filtersJson) {
    prevFiltersJson.current = filtersJson;
    if (opts.page === undefined && localPage !== 1) setLocalPage(1);
  }

  const refresh = useCallback(async () => {
    const version = ++request.current;
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    if (!enabled) { setData(null); setLoading(false); setError(null); return; }
    const { filters, limit } = optsRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listRuns({ ...filters, page, limit: limit ?? 20 }, controller.signal);
      if (version === request.current) {
        const lastPage = Math.max(1, Math.ceil(result.total / (limit ?? 20)));
        if (page > lastPage) (optsRef.current.onPageChange ?? setLocalPage)(lastPage);
        setData(result);
      }
    } catch (e) { if (version === request.current) setError(e instanceof Error ? e.message : 'Unable to load runs'); }
    finally { if (version === request.current) setLoading(false); }
  }, [page, filtersJson, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void refresh(); return () => { request.current++; activeRead.current?.abort(); }; }, [refresh]);

  return { runs: data?.runs ?? [], total: data?.total ?? 0, unreadable: data?.unreadable ?? [], page, setPage, loading, error, refresh };
}
