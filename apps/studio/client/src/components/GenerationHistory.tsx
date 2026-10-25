import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteTranslationHistory, restoreTranslationHistory, listTranslations, type GenerationSummary, type GenerationGroup, type GenerationList } from '../api/translate';

const groups: { key: GenerationGroup; label: string; color: string }[] = [
  { key: 'attention', label: 'Needs your input', color: 'bg-orange-100 text-orange-900' },
  { key: 'active', label: 'In progress', color: 'bg-blue-100 text-blue-900' },
  { key: 'published', label: 'Published', color: 'bg-green-100 text-green-900' },
  { key: 'ended', label: 'Ended without publishing', color: 'bg-gray-200 text-gray-800' },
  { key: 'error', label: 'Errors', color: 'bg-red-100 text-red-900' },
];
const labels: Record<GenerationSummary['phase'], string> = {
  cc_running: 'Generating', cc_waiting_for_answer: 'Your answer needed', auto_fixing: 'Fixing compilation',
  confirm_merge: 'Your review needed', done: 'Ended without publishing', error: 'Generation error', unavailable: 'Unable to read task',
};
function groupOf(task: GenerationSummary) {
  return task.phase === 'done' ? task.published ? 'published' : 'ended'
    : ['cc_waiting_for_answer', 'confirm_merge'].includes(task.phase) ? 'attention'
    : ['cc_running', 'auto_fixing'].includes(task.phase) ? 'active' : 'error';
}
function relativeTime(date: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}
function Tasks({ tasks, onDeleted }: { tasks: GenerationSummary[]; onDeleted: (id: string) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove(id: string) {
    setBusy(true); setError(null);
    try { await deleteTranslationHistory(id); setConfirm(null); onDeleted(id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not delete history. Refresh and try again.'); }
    finally { setBusy(false); }
  }
  return <ul className="mt-3 space-y-2">{tasks.map(task => <li key={task.sessionId} className="rounded border border-gray-200 bg-gray-50 p-3">
    <Link to={`/translate/${encodeURIComponent(task.sessionId)}`} className="block text-sm text-teal-800 underline break-words">
      <span className="line-clamp-2 whitespace-pre-wrap">{task.naturalLanguage || `Task ${task.sessionId}`}</span>
    </Link>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${groups.find(group => group.key === groupOf(task))!.color}`}>{task.published ? 'Published' : labels[task.phase]}</span>
      <time dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString()} className="text-xs text-gray-600">Updated {relativeTime(task.updatedAt)}</time>
      {task.canDelete && <button type="button" className="ml-auto text-xs text-muted hover:text-red-700" aria-label={`Delete history: ${task.naturalLanguage || task.sessionId}`} onClick={event => { deleteTrigger.current = event.currentTarget; setConfirm(task.sessionId); setError(null); }}>Delete</button>}
    </div>
    {confirm === task.sessionId && <div className="mt-3 border-t border-line pt-3 text-sm">
      <p>Delete this history entry? Published workflows and runs are kept.</p>
      {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
      <div className="mt-2 flex gap-3"><button disabled={busy} onClick={() => void remove(task.sessionId)} className="rounded bg-red-700 px-3 py-1 text-white disabled:opacity-50">{busy ? 'Deleting…' : 'Delete entry'}</button><button disabled={busy} onClick={() => { setConfirm(null); deleteTrigger.current?.focus(); }}>Cancel</button></div>
    </div>}
  </li>)}</ul>;
}
function useHistory(group: GenerationGroup | 'recent', page: number, revision: number) {
  const [data, setData] = useState<GenerationList | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const queryKey = useRef('');
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
    const key = `${group}:${page}`;
    if (queryKey.current !== key) { setData(null); queryKey.current = key; }
    setLoading(true); setError(null);
    async function refresh() {
      const controller = new AbortController(); active = controller;
      const deadline = setTimeout(() => controller.abort(), 15000);
      try {
        const next = await listTranslations(page * 5, controller.signal, { group, limit: 5 });
        if (!cancelled) { setData(next); setError(null); }
      } catch (failure) { if (!cancelled) setError(controller.signal.aborted ? 'Loading history timed out.' : (failure as Error).message); }
      finally { clearTimeout(deadline); if (!cancelled) { setLoading(false); timer = setTimeout(refresh, 5000); } }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); active?.abort(); };
  }, [group, page, revision]);
  return { data, error, loading };
}
function HistoryGroup({ group, revision, onDeleted }: { group: GenerationGroup; revision: number; onDeleted: (id: string) => void }) {
  const [page, setPage] = useState(0);
  const { data, error, loading } = useHistory(group, page, revision);
  useEffect(() => { if (data && page > 0 && !data.sessions.length) setPage(Math.max(0, Math.ceil(data.total / 5) - 1)); }, [data, page]);
  return <div className="pb-3">
    {loading && <p role="status">Loading tasks…</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error} Retrying automatically. {data && 'Displayed tasks may be out of date.'}</p>}
    {data && <><Tasks tasks={data.sessions} onDeleted={onDeleted} />{!data.total && <p className="text-sm text-gray-600 mt-2">No tasks in this group.</p>}
      {data.total > 5 && <div className="mt-3 flex gap-3 text-sm"><button className="text-teal-800 disabled:opacity-40" disabled={!page || loading} onClick={() => setPage(p => p - 1)}>Previous tasks</button><span>Page {page + 1}</span><button className="text-teal-800 disabled:opacity-40" disabled={(page + 1) * 5 >= data.total || loading} onClick={() => setPage(p => p + 1)}>Next tasks</button></div>}</>}
  </div>;
}
export function GenerationHistory() {
  const [expanded, setExpanded] = useState(true), [revision, setRevision] = useState(0);
  const [openGroups, setOpenGroups] = useState<GenerationGroup[]>([]);
  const [deletedId, setDeletedId] = useState<string | null>(null), [restoreError,setRestoreError] = useState<string | null>(null), [restoring,setRestoring] = useState(false);
  const initialized = useRef(false);
  const { data, error, loading } = useHistory('recent', 0, revision);
  useEffect(() => {
    if (data?.counts && !initialized.current) {
      initialized.current = true;
      setOpenGroups((['attention','active'] as GenerationGroup[]).filter(group => (data.counts?.[group] ?? 0) > 0));
    }
  }, [data]);
  const refresh = () => setRevision(v => v + 1);
  return <section className="border-t border-line pt-5" aria-label="Generation history">
    <div className="flex items-center justify-between gap-3">
      <h2><button aria-expanded={expanded} aria-controls="generation-history-content" onClick={() => setExpanded(v => !v)} className="font-semibold">{expanded ? '▾' : '▸'} Generation history{data ? ` (${data.allTotal ?? data.total})` : ''}</button></h2>
      <button disabled={loading} onClick={refresh} className="text-sm subtle-link disabled:opacity-50">{loading ? 'Loading…' : 'Refresh'}</button>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error} Try refreshing.{data ? ' Displayed tasks may be out of date.' : ''}</p>}
    {deletedId && <div role="status" className="mt-3 text-sm">History entry deleted. <button disabled={restoring} className="subtle-link" onClick={async () => { setRestoring(true); setRestoreError(null); try { await restoreTranslationHistory(deletedId); setDeletedId(null); refresh(); } catch (failure) { setRestoreError((failure as Error).message); } finally { setRestoring(false); } }}>{restoring ? 'Restoring…' : 'Undo'}</button>{restoreError && <p role="alert" className="text-red-700">{restoreError}</p>}</div>}
    <div id="generation-history-content" hidden={!expanded} className="mt-3">
      {groups.map(group => <div key={group.key} className="border-b border-line">
        <button aria-expanded={openGroups.includes(group.key)} aria-controls={`history-${group.key}`} onClick={() => setOpenGroups(previous => previous.includes(group.key) ? previous.filter(key => key !== group.key) : [...previous, group.key])} className="py-3 text-sm w-full flex items-center gap-2 text-left">
          <span className="text-muted w-3">{openGroups.includes(group.key) ? '▾' : '▸'}</span><span className="font-medium">{group.label}</span><span className={`ml-auto rounded-full px-2 py-0.5 text-xs ${group.color}`}>{data?.counts?.[group.key] ?? '…'}</span>
        </button>
        <div id={`history-${group.key}`} hidden={!openGroups.includes(group.key)}>{expanded && openGroups.includes(group.key) && <HistoryGroup group={group.key} revision={revision} onDeleted={id => { setDeletedId(id); setRestoreError(null); refresh(); }} />}</div>
      </div>)}
    </div>
  </section>;
}
