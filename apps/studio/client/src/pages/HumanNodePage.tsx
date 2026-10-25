import { createClientId } from '../lib/client-id';
import { humanTaskKey, type InboxDraft } from '../lib/human-inbox';
import { loadInboxDrafts, saveInboxDraft, isInboxDraftStorageKey } from '../lib/human-inbox-drafts';
import { HumanOutputField, ResolvedInputValue } from '../components/HumanTaskFields';
import { parseHumanOutputValue } from '@openhilo/itt-contracts/human-output';
import type { ValueType } from '@openhilo/itt-contracts';
// platform/client/src/pages/HumanNodePage.tsx
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import type { HumanSubmission } from '@openhilo/human-contracts';
import { getHumanNode, HumanRequestError, submitHumanTask, type HumanNodeDetail } from '../api/human';

// ── Validation ────────────────────────────────────────────────────────────────

function validate(kind: string, value: string): string | null {
  try { parseHumanOutputValue(value, kind as ValueType, 'answer'); return null; }
  catch (error) { return (error as Error).message; }
}

// ── HumanNodePage ─────────────────────────────────────────────────────────────

export function HumanNodePage() {
  const { id } = useParams<{ id: string }>();
  return id ? <HumanTaskForm key={id} id={id} /> : null;
}

function HumanTaskForm({ id }: { id: string }) {
  const nav = useNavigate();
  const [node, setNode] = useState<HumanNodeDetail | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submission = useRef<HumanSubmission | null>(null);
  const busy = useRef(false);
  const nodeRef = useRef<HumanNodeDetail | null>(null);
  const [draftLocked, setDraftLocked] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  function persist(n: HumanNodeDetail, draft: InboxDraft | null) {
    if (!saveInboxDraft(humanTaskKey({ ...n, runId: id }), draft)) setStorageUnavailable(true);
  }
  function restoreDraft(n: HumanNodeDetail) {
    const stored = loadInboxDrafts();
    if (stored.unavailable) setStorageUnavailable(true);
    const draft = stored.drafts[humanTaskKey({ ...n, runId: id })];
    submission.current = n.acceptedSubmission ?? draft?.submission ?? null;
    setValues(n.acceptedSubmission?.outputs ?? draft?.values ?? Object.fromEntries(n.outputs.map(o => [o.name, ''])));
    setDraftLocked(Boolean(draft?.attempted));
  }
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (!isInboxDraftStorageKey(event.key) || busy.current || !nodeRef.current || nodeRef.current.acceptedSubmission) return;
      restoreDraft(nodeRef.current);
    }
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [id]);
  const [closed, setClosed] = useState(false);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let initial: HumanNodeDetail | null = null;
    async function refresh() {
      let finished = false;
      try {
        if (busy.current) return;
        const n = { ...await getHumanNode(id), runId: id };
        if (cancelled || busy.current) return;
        setSyncError(null);
        if (initial && n.taskId !== initial.taskId) {
          persist(initial, null); setClosed(true); finished = true; return;
        }
        if (!initial || n.acceptedSubmission) {
          setNode(n);
          nodeRef.current = n;
          if (n.acceptedSubmission) persist(n, null);
          restoreDraft(n);
        }
        initial = n;
      } catch (e) {
        if (cancelled || busy.current) return;
        if (e instanceof HumanRequestError && [400, 404, 409].includes(e.status)) {
          if (initial) persist(initial, null);
          setClosedReason(e.message);
          setClosed(true); finished = true;
        } else setSyncError(`${(e instanceof Error ? e.message : String(e)).replace(/[.!。]+$/, '')}. Retrying automatically…`);
      } finally {
        if (!cancelled && !finished) timer = setTimeout(refresh, 2000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id]);

  function handleChange(name: string, v: string) {
    if (!node || node.acceptedSubmission || draftLocked) return;
    submission.current = null;
    const next = { ...values, [name]: v };
    setValues(next);
    persist(node, { values: next });
  }

  // Per-field errors (only show once a field has been touched — but compute always for submit guard)
  const fieldErrors = node
    ? Object.fromEntries(node.outputs.map(o => [o.name, validate(o.kind, values[o.name] ?? '')]))
    : {};
  const hasErrors = Object.values(fieldErrors).some(e => e !== null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submitAnswer();
  }

  async function submitAnswer() {
    if (!node || !node.taskId || closed || busy.current || (!node.acceptedSubmission && !draftLocked && hasErrors)) return;
    busy.current = true;
    setSubmitting(true); setError(null);
    try {
      // Another tab may have locked an answer since this page last rendered.
      const stored = loadInboxDrafts().drafts[humanTaskKey({ ...node, runId: id })];
      if (stored?.attempted && !node.acceptedSubmission) {
        submission.current = stored.submission ?? null;
        setValues(stored.values); setDraftLocked(true);
        if (JSON.stringify(stored.values) !== JSON.stringify(values)) {
          setError('An answer from another tab was restored. Review and retry that same answer.'); return;
        }
      }
      if (node.acceptedSubmission) submission.current = node.acceptedSubmission;
      // Keep the same receipt identity when a response is lost and the user retries.
      if (!submission.current) {
        submission.current = { taskId: node.taskId, submissionId: createClientId(), outputs: { ...values } };
      }
      if (!node.acceptedSubmission) {
        persist(node, { values: { ...values }, submission: submission.current, attempted: true });
        setDraftLocked(true);
      }
      const receipt = await submitHumanTask(id, submission.current);
      if (!['accepted', 'duplicate'].includes(receipt.status)) throw new HumanRequestError(receipt.message ?? 'Answer not accepted. Refresh the request.', receipt.status === 'invalid' ? 400 : 409);
      persist(node, null);
      nav(`/runs/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof HumanRequestError && e.status === 400) {
        persist(node, { values: { ...values } }); setDraftLocked(false); submission.current = null;
      }
      if (e instanceof HumanRequestError && [404, 409].includes(e.status)) { persist(node, null); setClosed(true); setClosedReason(e.message); }
      // Acceptance can precede a failed worker launch or a lost HTTP response.
      // Restore the durable answer so retries also survive a page reload.
      if (node.taskId) {
        const current = await getHumanNode(id).catch(e => {
          if (e instanceof HumanRequestError && [400, 404, 409].includes(e.status)) { setClosed(true); setClosedReason(e.message); }
          return null;
        });
        if (current && current.taskId !== node.taskId) setClosed(true);
        if (current?.taskId === node.taskId && current.acceptedSubmission) {
          persist(node, null); nodeRef.current = current; setNode(current); submission.current = current.acceptedSubmission; setValues(current.acceptedSubmission.outputs);
        }
      }
    } finally { busy.current = false; setSubmitting(false); }
  }

  if (error && !node) return <div className="text-red-600 text-sm">{error}</div>;
  if (closed) return <div className="max-w-lg space-y-4">
    <h1 className="text-xl font-bold">Your response</h1>
    {node && <p className="text-sm">{node.prompt}</p>}
    <p role="status">{closedReason ?? 'This task is no longer waiting for your answer. It may have been handled in another tab. Your old form cannot be submitted again.'}</p>
    <button onClick={() => nav(`/runs/${id}`)} className="px-4 py-2 rounded bg-teal-700 text-white text-sm">View run status</button>
  </div>;
  if (!node) return <div role="status" className="text-sm">{syncError ?? 'Loading human task…'}</div>;

  return (
    <div className="max-w-2xl">
      <Link className="subtle-link text-sm inline-block mb-5" to={`/runs/${encodeURIComponent(id ?? '')}`}>Back to run</Link><header className="page-heading"><div><h1>Your response</h1><p>Review the request and provide the result to continue this workflow.</p></div></header>
      <div className="mb-4 p-3 bg-orange-50 rounded border border-orange-200">
        <div className="text-sm font-medium text-gray-800">{node.prompt}</div>
      </div>
      {Object.entries(node.resolvedInputs).length > 0 && (
        <div className="mb-4 space-y-2">
          {Object.entries(node.resolvedInputs).map(([k, v]) => (
            <div key={k} className="p-2 bg-gray-50 border border-gray-200 rounded">
              <div className="text-xs font-medium text-gray-500 mb-0.5">{k}</div>
              <ResolvedInputValue raw={v} />
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-gray-500 mb-3">Drafts are shared with Human inbox and kept in this browser for this request and round. Accepted answers are cleared.</p>
      {storageUnavailable && <p role="alert" className="text-sm text-amber-700">Browser draft storage is unavailable. Keep this page open until you finish.</p>}
      {draftLocked && !submitting && !node.acceptedSubmission && <p role="status" className="text-sm text-amber-700 mb-3">Your previous answer has no confirmed outcome. Its original answer is restored and locked. Retry that same answer or check run status.</p>}
      {error && <p role="alert" className="text-red-600 text-sm mb-3">{error}</p>}
      {syncError && <p role="status" className="text-amber-700 text-sm mb-3">{syncError}</p>}
      {node.acceptedSubmission && <p role="status" className="text-sm text-gray-700 mb-3">
        Your answer was accepted. The workflow is waiting to continue.
      </p>}
      <form onSubmit={handleSubmit}>
        {node.outputs.length > 0 ? <h2 className="text-sm font-semibold text-gray-700 mb-2">Your answer</h2>
          : !node.acceptedSubmission && !draftLocked && <p className="text-sm text-gray-600 mb-2">Complete this task to continue the workflow.</p>}
        <fieldset disabled={submitting || draftLocked || Boolean(node.acceptedSubmission)}>
        {node.outputs.map(o => (
          <div key={o.name} className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              {o.name} <span className="text-gray-600">({o.kind})</span>
            </label>
            <HumanOutputField
              name={o.name}
              kind={o.kind}
              value={values[o.name] ?? ''}
              onChange={v => handleChange(o.name, v)}
              error={!node.acceptedSubmission && values[o.name] !== '' ? (fieldErrors[o.name] ?? null) : null}
            />
          </div>
        ))}
        </fieldset>
        {!node.acceptedSubmission && !draftLocked && hasErrors && <p role="status" className="text-sm text-gray-600">Complete required outputs: {Object.keys(fieldErrors).filter(name => fieldErrors[name]).join(', ')}.</p>}
        <button
          type="submit"
          disabled={!node.taskId || submitting || (!node.acceptedSubmission && !draftLocked && hasErrors)}
          className="mt-2 px-4 py-2 rounded bg-teal-700 text-white text-sm font-medium disabled:opacity-50 hover:bg-teal-800"
        >
          {submitting ? 'Submitting…' : node.acceptedSubmission ? 'Retry continuation' : draftLocked ? 'Retry same answer' : node.outputs.length === 0 ? 'Complete' : 'Submit results'}
        </button>
      </form>
    </div>
  );
}
