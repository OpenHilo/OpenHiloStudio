// platform/client/src/pages/HistoryPage.tsx
import { useSearchParams } from 'react-router-dom';
import { FilterBar } from '../components/FilterBar';
import { RunList } from '../components/RunList';
import { useRuns } from '../hooks/useRuns';
import { useRunPage } from '../hooks/useRunPage';

interface Filters { intent?: string; status?: string; workdir?: string; createdAfter?: string; createdBefore?: string; completedOn?: string; }

export function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { page, setPage } = useRunPage();
  const filters: Filters = Object.fromEntries(['intent', 'status', 'workdir', 'createdAfter', 'createdBefore', 'completedOn'].flatMap(key => searchParams.get(key) ? [[key, searchParams.get(key)!]] : []));
  const { unreadable, runs, total, loading, error, refresh } = useRuns({ filters: filters as Record<string, string>, page, onPageChange: setPage });

  return (
    <div>
      <header className="page-heading"><div><h1>Runs</h1><p>Follow work in progress, review results, or open the workflow behind a run.</p></div></header>
      <FilterBar initial={filters} onChange={next => {
        // Commit controlled filter values before the next input event composes its update.
        setSearchParams(Object.fromEntries(Object.entries(next).filter((entry): entry is [string, string] => Boolean(entry[1]))), { replace: true, flushSync: true });
      }} />
      {error ? <div role="alert" className="text-sm text-red-600">Unable to load runs: {error} <button className="underline" onClick={() => void refresh()}>Retry loading</button></div> : loading ? <div role="status" className="text-sm text-gray-600">Loading…</div> : (
        <RunList unreadable={unreadable} runs={runs} total={total} page={page} hasFilters={Object.values(filters).some(Boolean)} onPageChange={setPage} onRefresh={refresh} />
      )}
    </div>
  );
}
