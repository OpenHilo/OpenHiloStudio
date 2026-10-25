// platform/client/src/pages/SchedulesPage.tsx
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'react-router-dom';
import {workflowLibraryHref, resolveWorkflowReference} from '../lib/workflow-links';
import { listSchedules, createSchedule, patchSchedule, deleteSchedule, type Schedule } from '../api/schedules';
import {listIntents} from '../api/entities';
import { ScheduleCreateForm } from '../components/ScheduleCreateForm';

export function SchedulesPage() {
  const [workflows,setWorkflows]=useState<Awaited<ReturnType<typeof listIntents>>>([]);
  useEffect(()=>{let active=true;listIntents().then(items=>{if(active)setWorkflows(items);}).catch(()=>{});return()=>{active=false;};},[]);
  const workflowName=(s:Schedule)=>resolveWorkflowReference(workflows,s.ittPath)?.name??s.ittPath.replace(/\\/g,'/').split('/').pop()?.replace(/\.itt(?:\.impl)?\.json$/,'')??s.ittPath;
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Schedule | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  const revision = useRef(0);
  const reading = useRef(false);

  async function refresh(background = false) {
    if (busy.current || reading.current) return;
    reading.current = true;
    const current = ++revision.current;
    if (!background) setLoading(true);
    try {
      const next = await listSchedules();
      if (current === revision.current) { setSchedules(next); setLoadError(null); }
    } catch (e) { if (current === revision.current) setLoadError((e as Error).message); }
    finally { reading.current = false; if (current === revision.current) setLoading(false); }
  }
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick(initial = false) {
      await refresh(!initial);
      if (!cancelled) timer = setTimeout(tick, 2000);
    }
    void tick(true);
    return () => { cancelled = true; clearTimeout(timer); revision.current++; };
  }, []);

  async function change(key: string, operation: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true; revision.current++;
    setLoading(false); setPending(key); setError(null); setNotice(null);
    try { await operation(); }
    catch (e) { setError((e as Error).message); }
    finally { busy.current = false; setPending(null); }
  }

  async function handleCreate(input: Parameters<typeof createSchedule>[0]) {
    await change('create', async () => {
      const created = await createSchedule(input);
      setSchedules(items => [...items, created]);
      setShowForm(false);
      setNotice(`Schedule “${created.name}” created and ${created.enabled ? 'enabled' : 'disabled'}.`);
    });
  }

  async function toggleEnabled(s: Schedule) {
    await change(s.id, async () => {
      const updated = await patchSchedule(s.id, { enabled: !s.enabled });
      setSchedules(items => items.map(item => item.id === s.id ? updated : item));
      setNotice(`Schedule “${updated.name}” ${updated.enabled ? 'enabled' : 'disabled'}.`);
    });
  }

  async function handleDelete(id: string) {
    if (busy.current) return;
    await change(id, async () => {
      await deleteSchedule(id);
      setSchedules(items => items.filter(item => item.id !== id));
      setDeleteTarget(null);
      setNotice('Schedule deleted.');
    });
  }

  return (
    <div>
      <div className="page-heading">
        <div><h1>Schedules</h1><p>Choose when a workflow runs and follow its latest result.</p></div>
        <div className="flex gap-2">
          <button disabled={loading || pending !== null} onClick={() => void refresh()} className="px-3 py-1.5 text-sm rounded border disabled:opacity-50">{loading ? 'Refreshing…' : 'Refresh'}</button>
          <button disabled={pending !== null} onClick={() => setShowForm(s => !s)} className="px-3 py-1.5 text-sm rounded bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-50">{showForm ? 'Hide form' : 'New schedule'}</button>
        </div>
      </div>
      {error && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {loadError && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{loadError} Displayed schedules may be out of date.</p>}
      {notice && <p role="status" className="mb-4 text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
      <p className="mb-3 text-xs text-gray-500">Updates automatically. Run times are displayed in your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}); each cron schedule shows its execution time zone.</p>

      {showForm && <ScheduleCreateForm pending={pending === 'create'} onCreate={handleCreate} />}

      <table className="run-table w-full text-sm surface">
        <thead>
          <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
            <th className="text-left py-2 pr-3">Name</th>
            <th className="text-left py-2 pr-3">Workflow</th>
            <th className="text-left py-2 pr-3">Cron</th>
            <th className="text-left py-2 pr-3">Flexible</th>
            <th className="text-left py-2 pr-3">Last run</th>
            <th className="text-left py-2 pr-3">Next run</th>
            <th className="text-left py-2 pr-3">Enabled</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {schedules.map(s => (
            <tr key={s.id} className="border-b border-gray-100">
              <td className="py-2 pr-3 font-medium">{s.name}
                {s.lastAttempt && <div className="mt-1 max-w-sm break-words text-xs font-normal" role="status">
                  <span className={s.lastAttempt.status === 'failed' || s.lastAttempt.status === 'unknown' ? 'text-red-700 dark:text-red-400' : 'text-gray-500'}>
                    {s.lastAttempt.status === 'pending' ? 'Waiting for launch receipt' : s.lastAttempt.status === 'launched' ? 'Run created' : s.lastAttempt.status === 'failed' ? 'Launch failed' : 'Launch receipt not saved'}
                    {' · '}{new Date(s.lastAttempt.startedAt).toLocaleString()}
                  </span>
                  {s.lastAttempt.status === 'pending' && <div>The launch has not been confirmed. Check run history before retrying; restarting the server does not replay this trigger.</div>}
                  {s.lastAttempt.error && <div className="text-red-700 dark:text-red-400">{s.lastAttempt.error}</div>}
                  {s.lastAttempt.runId && <Link className="text-teal-700 underline" to={`/runs/${encodeURIComponent(s.lastAttempt.runId)}`}>View triggered run</Link>}
                </div>}
              </td>
              <td className="py-2 pr-3"><Link className="subtle-link" title={s.ittPath} to={workflowLibraryHref({intent:workflowName(s),ittPath:s.ittPath})}>{workflowName(s)}</Link></td>
              <td className="py-2 pr-3 font-mono text-xs">
                {s.flexible && s.assignedCron ? (
                  <span title={`original: ${s.cron}`}>{s.assignedCron}</span>
                ) : s.cron}
                <div className="mt-1 font-sans text-gray-500">{s.timeZone ?? 'Execution time zone not reported'}</div>
              </td>
              <td className="py-2 pr-3">
                {s.flexible
                  ? <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">flexible</span>
                  : <span className="text-xs text-gray-600">—</span>}
              </td>
              <td className="py-2 pr-3 text-xs text-gray-500">{s.lastRunId ? <Link className="text-teal-700 underline" to={`/runs/${encodeURIComponent(s.lastRunId)}`}>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : 'View last run'}</Link> : s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : 'Not yet triggered'}</td>
              <td className="py-2 pr-3 text-xs text-gray-500">{!s.enabled ? 'Disabled' : s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : 'Not reported by scheduler'}</td>
              <td className="py-2 pr-3">
                <button disabled={pending !== null} aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`} onClick={() => void toggleEnabled(s)} className={`text-xs px-2 py-0.5 rounded-full disabled:opacity-50 ${s.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                  {pending === s.id ? 'Saving…' : s.enabled ? 'On' : 'Off'}
                </button>
              </td>
              <td className="py-2 text-right">
                <button disabled={pending !== null} onClick={event => { deleteTrigger.current = event.currentTarget; setError(null); setDeleteTarget(s); }} className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50">Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Dialog.Root open={deleteTarget !== null} onOpenChange={open => { if (!open && !busy.current) setDeleteTarget(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content onCloseAutoFocus={event => { event.preventDefault(); if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus(); }} className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,90vw)] -translate-x-1/2 -translate-y-1/2 rounded bg-white p-5 shadow-xl dark:bg-gray-900">
            <Dialog.Title className="text-lg font-semibold">Delete schedule “{deleteTarget?.name}”?</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-gray-600 dark:text-gray-300">This removes the schedule and stops future triggers. Existing runs are kept. This cannot be undone.</Dialog.Description>
            {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close asChild><button disabled={pending !== null} className="rounded border px-3 py-1.5 text-sm">Cancel</button></Dialog.Close>
              <button disabled={pending !== null} onClick={() => { if (deleteTarget) void handleDelete(deleteTarget.id); }} className="rounded bg-red-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">{pending === deleteTarget?.id ? 'Deleting…' : 'Delete schedule'}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {loading && <div role="status" className="text-sm text-gray-500 mt-4">Loading schedules…</div>}
      {!loading && !error && !loadError && !schedules.length && <div className="text-sm text-gray-500 mt-4">No schedules yet. Create a schedule to run a workflow automatically.</div>}
    </div>
  );
}
