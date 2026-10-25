import { useEffect, useState } from 'react';
import { readRunArtifact } from '../api/run-artifacts';

/** Cancel abandoned reads and ignore responses for a different resource or retry. */
export function useRunArtifact<T>(url: string | undefined, decode: (value: unknown) => T, revision = '') {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ url?: string; attempt: number; revision?: string; data?: T; error?: string }>({ attempt: -1 });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let current = true;
    setState({ url, attempt, revision });
    void readRunArtifact(url, decode, controller.signal).then(
      data => { if (current) setState({ url, attempt, revision, data }); },
      error => { if (current) setState({ url, attempt, revision, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { current = false; controller.abort(); };
  }, [url, decode, attempt, revision]);
  const matching = state.url === url && state.attempt === attempt && state.revision === revision;
  return {
    data: matching ? state.data : undefined,
    error: matching ? state.error : undefined,
    loading: Boolean(url) && (!matching || (state.data === undefined && !state.error)),
    retry: () => setAttempt(value => value + 1),
  };
}
