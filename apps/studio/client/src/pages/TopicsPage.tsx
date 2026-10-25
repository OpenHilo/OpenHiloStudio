// platform/client/src/pages/TopicsPage.tsx
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useRuns } from '../hooks/useRuns';
import { useRunPage } from '../hooks/useRunPage';
import { RunList } from '../components/RunList';
import { RunTriggerDialog } from '../components/RunTriggerDialog';
import { listFilters, type SavedFilter } from '../api/filters';

export function TopicsPage() {
  const { filterId } = useParams<{ filterId: string }>();
  const [filter, setFilter] = useState<SavedFilter | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [filterLoading, setFilterLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [triggerOpen, setTriggerOpen] = useState(false);

  const { page, setPage } = useRunPage();
  const conditions = (filter?.conditions ?? {}) as Record<string, string>;
  const { unreadable, runs, loading, error, total, refresh } = useRuns({ filters: conditions, page, onPageChange: setPage, enabled: Boolean(filter && filter.id === filterId) });

  useEffect(() => {
    if (!filterId) return;
    let current = true;
    const controller = new AbortController();
    setFilter(null); setFilterError(null); setFilterLoading(true);
    // No GET /api/filters/:id endpoint exists — fetch all and find by id
    listFilters(controller.signal)
      .then(list => {
        if (!current) return;
        const found = list.find(f => f.id === filterId) ?? null;
        setFilter(found);
        if (!found) setFilterError('Saved view not found. Choose another view or save filters from Runs.');
      })
      .catch(e => { if (current) setFilterError(`Unable to load saved view: ${e instanceof Error ? e.message : String(e)}`); })
      .finally(() => { if (current) setFilterLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [filterId, reload]);

  // Extract intent from filter conditions for pre-fill
  const prefillIntent = (filter?.conditions as Record<string, unknown>)?.intent as string | undefined;

  if (filterError) return <div role="alert" className="text-sm text-red-600">{filterError} <button className="underline" onClick={() => setReload(value => value + 1)}>Retry loading</button></div>;
  if (filterLoading || !filter || filter.id !== filterId) return <div role="status">Loading saved view…</div>;

  return (
    <div className="flex flex-col h-full">
      {/* Topic header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-gray-900 dark:text-gray-100 text-lg">{filter.name}</h1>
          {filter && (
            <div className="text-xs text-gray-500 mt-0.5">
              {Object.entries(filter.conditions ?? {})
                .filter(([, v]) => v)
                .map(([k, v]) => `${k}=${v}`)
                .join(' · ')}
            </div>
          )}
        </div>
        <button
          onClick={() => setTriggerOpen(true)}
          className="text-sm px-3 py-1.5 bg-teal-700 text-white rounded hover:bg-teal-800"
        >
          Run workflow
        </button>
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-auto px-4 py-3">
          {error ? <div role="alert" className="text-sm text-red-600">Unable to load runs: {error} <button className="underline" onClick={() => void refresh()}>Retry loading</button></div> : loading ? <div role="status" className="text-sm text-gray-600">Loading…</div> : (
          <RunList unreadable={unreadable} runs={runs} total={total} page={page} hasFilters={Object.values(conditions).some(Boolean)} onPageChange={setPage} onRefresh={refresh} />
        )}
      </div>

      <RunTriggerDialog
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        prefillIntent={prefillIntent}
      />
    </div>
  );
}
