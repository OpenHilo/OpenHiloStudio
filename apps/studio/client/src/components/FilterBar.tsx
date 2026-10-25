// platform/client/src/components/FilterBar.tsx
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from 'react-router-dom';
import { createFilter } from '../api/filters';

import { WorkflowCombobox } from './WorkflowCombobox';
import { listIntents } from '../api/entities';

interface Filters { intent?: string; status?: string; workdir?: string; createdAfter?: string; createdBefore?: string; completedOn?: string; }

interface Props {
  initial?: Filters;
  readOnly?: boolean;
  onChange: (f: Filters) => void;
}

export function FilterBar({ initial = {}, readOnly, onChange }: Props) {
  const f = initial;
  const [workflows, setWorkflows] = useState<{ name: string; desc: string; ittPath: string }[]>([]);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  useEffect(() => {
    let active = true;
    listIntents().then(items => { if (active) { setWorkflows(items.map(item => ({ ...item, ittPath: item.name }))); setWorkflowError(null); } })
      .catch(error => { if (active) setWorkflowError(String(error)); });
    return () => { active = false; };
  }, [workflowRevision]);
  const choices = f.intent && !workflows.some(item => item.name === f.intent)
    ? [{ name: f.intent, desc: 'Current filter', ittPath: f.intent }, ...workflows] : workflows;
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  function update(key: keyof Filters, value: string) {
    const next = { ...f, [key]: value || undefined };
    onChange(next);
  }

  async function saveAsTopic() {
    if (savingRef.current) return;
    if (!name.trim()) { setError('View name is required'); return; }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const topic = await createFilter({ name: name.trim(), conditions: f as Record<string, unknown> });
      window.dispatchEvent(new Event('intentorch:filters-updated'));
      setOpen(false); setName('');
      navigate(`/topics/${encodeURIComponent(topic.id)}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save view'); }
    finally { savingRef.current = false; setSaving(false); }
  }

  return (
    <div className="flex flex-wrap gap-2 mb-4 items-end">
      <div className="w-72 max-w-full">
        <WorkflowCombobox items={choices} value={f.intent ?? ''} disabled={Boolean(readOnly)} required={false}
          placeholder="Search workflows to filter" onChange={value => update('intent', value)} />
        {workflowError && <p role="alert" className="text-sm text-red-600">Unable to load workflows. <button onClick={() => setWorkflowRevision(v => v + 1)}>Retry loading workflows</button></p>}
      </div>
      <select aria-label="Run status" disabled={readOnly} className="border border-gray-300 rounded px-2 py-1 text-sm" value={f.status ?? ''} onChange={e => update('status', e.target.value)}>
        <option value="">All statuses</option>
        {f.status && !['running','completed','failed','aborted','suspended'].includes(f.status) && <option value={f.status} disabled>Invalid status: {f.status}</option>}
        {['running','completed','failed','aborted','suspended'].map(s => <option key={s}>{s}</option>)}
      </select>
      <input aria-label="Workdir prefix filter" disabled={readOnly} className="border border-gray-300 rounded px-2 py-1 text-sm" placeholder="Workdir prefix" value={f.workdir ?? ''} onChange={e => update('workdir', e.target.value)} />
      {f.completedOn&&<span className="rounded bg-green-50 text-green-800 px-3 py-1 text-sm">Completed {f.completedOn} (UTC) {!readOnly&&<button aria-label="Remove completion date filter" onClick={()=>update('completedOn','')}>×</button>}</span>}
      <Dialog.Root open={open} onOpenChange={next => { if (!savingRef.current) setOpen(next); }}>
      {!readOnly && (
        <Dialog.Trigger asChild><button onClick={() => setError(null)} disabled={saving} className="ml-auto text-sm px-3 py-1 rounded border border-blue-300 text-teal-800 hover:bg-blue-50">
          {saving ? 'Saving…' : 'Save view'}
        </button></Dialog.Trigger>
      )}
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
          <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-white dark:bg-gray-900 border p-5 shadow-xl">
            <Dialog.Title className="font-semibold text-lg">Save view</Dialog.Title>
            <Dialog.Description className="text-sm text-gray-500 mt-2">Save these filters to find the same group of runs later.</Dialog.Description>
            <p className="my-3 text-sm">{Object.entries(f).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'All runs'}</p>
            <form onSubmit={e => { e.preventDefault(); void saveAsTopic(); }}>
              <label htmlFor="topic-name" className="block text-sm mb-1">View name</label>
              <input id="topic-name" autoFocus disabled={saving} value={name} onChange={e => { setName(e.target.value); setError(null); }} className="w-full rounded border px-2 py-1 bg-transparent" />
              {error && <p role="alert" className="text-red-600 text-sm mt-2">{error}</p>}
              <div className="flex justify-end gap-2 mt-4">
                <Dialog.Close disabled={saving} className="px-3 py-1 border rounded">Cancel</Dialog.Close>
                <button disabled={saving} type="submit" className="px-3 py-1 rounded bg-teal-700 text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save view'}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
