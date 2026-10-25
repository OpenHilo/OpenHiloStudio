import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHumanTodos } from '../hooks/useHumanTodos';
import type { HumanNodeDetail, HumanTodo } from '../api/human';
import { HumanOutputField, ResolvedInputValue } from '../components/HumanTaskFields';
import { humanTaskKey, submitInboxItem, validateInboxDraft, type InboxDraft, type InboxResult } from '../lib/human-inbox';
import { isInboxDraftStorageKey, loadInboxDrafts, saveInboxDraft } from '../lib/human-inbox-drafts';

type Job = { key: string; node: HumanNodeDetail; draft: InboxDraft };
type Result = InboxResult & { node: HumanNodeDetail };
const freshDraft = (node: HumanTodo): InboxDraft => ({ values: Object.fromEntries((node.outputs ?? []).map(o => [o.name, ''])) });
const button = 'rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-40';

export function HumanInboxPage() {
  const { todos, loading, error, refresh } = useHumanTodos();
  const [{ drafts, unavailable }, setDraftState] = useState(loadInboxDrafts);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, Result>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('pending');
  const [page, setPage] = useState(1);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState('');
  const busy = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    function syncDrafts(event: StorageEvent) {
      if (!isInboxDraftStorageKey(event.key)) return;
      const stored = loadInboxDrafts();
      setDraftState(previous => stored.unavailable ? { ...previous, unavailable: true } : stored);
      setSelected(new Set());
      refresh();
    }
    window.addEventListener('storage', syncDrafts);
    return () => window.removeEventListener('storage', syncDrafts);
  }, []);
  function persistDraft(key: string, draft: InboxDraft | null) {
    const saved = saveInboxDraft(key, draft);
    if (alive.current) setDraftState(previous => {
      const next = { ...previous.drafts };
      if (draft) next[key] = draft; else delete next[key];
      return { drafts: next, unavailable: previous.unavailable || !saved };
    });
  }
  useEffect(() => {
    // Only an authoritative list can retire a draft; loading/errors keep it intact.
    if (loading || error) return;
    const pendingKeys = new Set(todos.filter(node => !node.acceptedSubmission).map(humanTaskKey));
    for (const key of Object.keys(drafts)) if (!pendingKeys.has(key)) persistDraft(key, null);
  }, [todos, loading, error]);
  useEffect(() => {
    setResults(previous => {
      let next = previous;
      for (const node of todos) {
        const key = humanTaskKey(node), result = previous[key];
        if (node.acceptedSubmission && result && result.state !== 'accepted') {
          if (next === previous) next = { ...previous };
          next[key] = { node: result.node, state: 'accepted', message: 'The saved answer is now confirmed. Check task details for continuation.' };
        }
      }
      return next;
    });
  }, [todos]);
  const draftFor = (node: HumanTodo) => drafts[humanTaskKey(node)] ?? freshDraft(node);
  const isWaiting = (node: HumanTodo) => Boolean(node.acceptedSubmission) || results[humanTaskKey(node)]?.state === 'accepted';
  const pendingCount = todos.filter(node => !isWaiting(node)).length;
  const sorted = [...todos].sort((a, b) => a.suspendedAt.localeCompare(b.suspendedAt) || humanTaskKey(a).localeCompare(humanTaskKey(b)));
  const filtered = sorted.filter(node => (filter === 'all' || (filter === 'pending' ? !isWaiting(node) : isWaiting(node)))
    && `${node.intent} ${node.prompt} ${node.runId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 20)), currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 20, currentPage * 20);
  const jobs = sorted.filter(node => selected.has(humanTaskKey(node)) && node.outputs && !isWaiting(node)
    && !['closed', 'accepted'].includes(results[humanTaskKey(node)]?.state ?? ''))
    .map(node => ({ key: humanTaskKey(node), node: node as HumanNodeDetail, draft: draftFor(node) }));
  const validJobs = jobs.filter(job => !Object.keys(validateInboxDraft(job.node, job.draft)).length);
  function update(node: HumanTodo, patch: Partial<InboxDraft>) {
    const key = humanTaskKey(node);
    persistDraft(key, { ...draftFor(node), ...patch });
    setSelected(previous => { const next = new Set(previous); next.delete(key); return next; });
  }
  async function submitBatch(batch: Job[]) {
    if (busy.current) return;
    busy.current = true; setProgress({ done: 0, total: batch.length }); setNotice('');
    try {
      for (const [index, job] of batch.entries()) {
        if (!alive.current) break;
        const result = await submitInboxItem(job.node, job.draft, undefined, draft => persistDraft(job.key, draft));
        persistDraft(job.key, ['accepted', 'closed'].includes(result.state) ? null
          : { ...job.draft, submission: result.submission, attempted: result.state === 'unknown' });
        if (!alive.current) break;
        setResults(previous => ({ ...previous, [job.key]: { ...result, node: job.node } }));
        setSelected(previous => { const next = new Set(previous); next.delete(job.key); return next; });
        setProgress({ done: index + 1, total: batch.length });
      }
      if (alive.current) { setNotice(`Batch processing finished (${batch.length} request${batch.length === 1 ? '' : 's'}). The latest result for each request is shown below.`); refresh(); }
    } finally { busy.current = false; if (alive.current) setProgress(null); }
  }
  return <div className="max-w-5xl space-y-4">
    <div className="page-heading"><h1 className="text-2xl font-bold">Human inbox</h1><button className={button} disabled={!!progress || loading} onClick={refresh}>Refresh requests</button></div>
    <p className="text-sm text-gray-600 dark:text-gray-300">Answer each request, then select the ones you are ready to submit together.</p>
    {unavailable && <p role="alert" className="rounded border border-amber-300 p-3 text-amber-800">Browser draft storage is unavailable or full. Your current inputs remain on this page, but may not survive a reload. Keep this page open until you finish.</p>}
    {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error} The list may be out of date; submissions are disabled until it refreshes.</p>}
    {loading && <p role="status">Loading human requests…</p>}
    {!loading && <p role="status">{pendingCount} awaiting an answer · {todos.length - pendingCount} with an answer already saved</p>}
    <div className="flex flex-wrap gap-3">
      <label className="text-sm">Search requests<input type="search" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} placeholder="Workflow, request or run ID" className="block rounded border p-2 bg-white text-gray-900" /></label>
      <label className="text-sm">Status<select value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }} className="block rounded border p-2 bg-white text-gray-900"><option value="pending">Awaiting answer</option><option value="saved">Answer saved / continuation</option><option value="all">All requests</option></select></label>
    </div>
    {notice && <p role="status" className="rounded border border-blue-200 p-3 text-sm">{notice}</p>}
    {progress && <p role="status" className="sticky top-0 z-10 rounded bg-blue-100 text-blue-900 p-3">Submitting answers: {progress.done} / {progress.total}. Each request is processed separately. Stay on this page until the batch finishes.</p>}
    {!loading && !error && !visible.length && <p className="rounded border p-4">{todos.length ? 'No matching requests.' : 'No pending human requests.'}</p>}
    <div className="space-y-3">{visible.map(todo => {
      const key = humanTaskKey(todo), draft = draftFor(todo), result = results[key];
      const supported = Array.isArray(todo.outputs) && Boolean(todo.taskId);
      const saved = isWaiting(todo), locked = saved || draft.attempted || result?.state === 'unknown' || result?.state === 'closed';
      const validation = supported ? validateInboxDraft(todo as HumanNodeDetail, draft) : {};
      const ready = supported && !saved && result?.state !== 'closed' && !Object.keys(validation).length;
      return <section key={key} aria-label={`${todo.intent}: ${todo.prompt}`} className="rounded border border-gray-300 bg-white p-4 text-gray-900 space-y-3">
        <div><h2 className="font-semibold">{todo.intent}</h2><p className="text-xs text-gray-500 break-all">{todo.runId} · Waiting since {new Date(todo.suspendedAt).toLocaleString()}</p></div>
        <p className="whitespace-pre-wrap break-words">{todo.prompt}</p>
        <div className="flex gap-3 text-sm"><Link className="text-teal-800 underline" to={`/runs/${todo.runId}`}>View run</Link><Link className="text-teal-800 underline" to={`/runs/${todo.runId}/human`}>{saved ? 'Check / retry continuation' : 'Open task details'}</Link></div>
        {Object.keys(todo.resolvedInputs).length > 0 && <details><summary className="cursor-pointer text-sm">Request context ({Object.keys(todo.resolvedInputs).length})</summary><div className="mt-2 space-y-2">{Object.entries(todo.resolvedInputs).map(([name, value]) => <div key={name}><span className="text-xs font-semibold">{name}</span><ResolvedInputValue raw={value} /></div>)}</div></details>}
        {saved ? <p role="status" className="text-sm text-blue-800">An answer is saved. It does not need another answer. Open task details if continuation needs attention.</p>
          : !supported ? <p className="text-sm">This request is missing its task identity or output schema. Refresh the requests before submitting.</p>
          : <>
            <fieldset disabled={locked || !!progress} className="space-y-3"><legend className="text-sm font-medium">Your outputs</legend>
              {todo.outputs!.length ? todo.outputs!.map(output => <fieldset key={output.name} className="space-y-1"><legend className="text-sm">{output.name} ({output.kind})</legend><HumanOutputField name={output.name} kind={output.kind} value={draft.values[output.name] ?? ''} onChange={value => update(todo, { values: { ...draft.values, [output.name]: value } })} error={draft.values[output.name] ? validation[output.name] ?? null : null} /></fieldset>) : <p className="text-sm">No outputs required. Select this request to complete it.</p>}
            </fieldset>
            <label className="inline-flex min-h-11 items-center gap-2 rounded px-2 -ml-2 text-sm cursor-pointer hover:bg-teal-50 focus-within:ring-2 focus-within:ring-teal-600"><input type="checkbox" className="h-4 w-4 accent-teal-700" checked={selected.has(key) && ready} disabled={!ready || !!progress || !!error || loading} onChange={e => { setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(key); else next.delete(key); return next; }); }} />Select request</label>
            {!ready && !locked && <p className="text-sm text-gray-600">Complete required outputs: {Object.keys(validation).join(', ')}.</p>}
            {result && <p role={result.state === 'failed' ? 'alert' : 'status'} className="text-sm">{result.message}{result.state === 'unknown' && draft.submission && ' Select this request to retry the original answer.'}</p>}
            {!result && !progress && draft.attempted && <p role="status" className="text-sm">A previous submission has no confirmed outcome yet. Its original answer is restored and locked. Check task details, or select this request to retry that same answer.</p>}
          </>}
      </section>;
    })}</div>
    {pages > 1 && <div className="flex items-center gap-3"><button className={button} disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage} / {pages}</span><button className={button} disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next</button></div>}
    <div className="rounded border p-3 space-y-2"><p className="text-sm">{validJobs.length} ready requests selected across all pages and filters. Editing an answer clears its selection.</p>
      <button className={button} disabled={!validJobs.length || !!progress || !!error || loading} onClick={() => void submitBatch(validJobs.map(job => ({ ...job, draft: { ...job.draft, values: { ...job.draft.values } } })))}>Submit selected results</button>
    </div>
    {!!Object.keys(results).length && <section aria-label="Submission results" className="space-y-2"><h2 className="font-semibold">Submission results (this page session)</h2>{Object.entries(results).map(([key, result]) => <div key={key} className="rounded border p-3 text-sm"><strong>{result.node.intent} · {result.state === 'unknown' ? 'Outcome unknown' : result.state}</strong><p>{result.node.prompt}</p><p>{result.message}</p><Link className="text-teal-800 underline" to={`/runs/${result.node.runId}`}>View run</Link></div>)}</section>}
  </div>;
}
