// platform/client/src/components/RunList.tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { type PlatformRun } from '../api/runs';

import { workflowLibraryHref } from '../lib/workflow-links';
import { RunTriggerDialog } from './RunTriggerDialog';

const STATUS_COLORS: Record<string, string> = {
  stopping: 'bg-amber-100 text-amber-800',
  running: 'bg-blue-100 text-teal-800',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  aborted: 'bg-gray-100 text-gray-600',
  suspended: 'bg-orange-100 text-orange-700',
};

interface Props {
  runs: PlatformRun[];
  total: number;
  unreadable?: { path: string; error: string }[];
  page: number;
  limit?: number;
  hasFilters?: boolean;
  onPageChange: (p: number) => void;
  onRefresh: () => void;
}

export function RunList({ runs, total, unreadable = [], page, limit = 20, hasFilters = false, onPageChange, onRefresh }: Props) {
  const nav = useNavigate();
  const totalPages = Math.ceil(total / limit);
  const [retryRun, setRetryRun] = useState<PlatformRun | null>(null);

  const canRetry = (r: PlatformRun) => !!r.ittPath && !r.stopping;
  const hasPendingHuman = (r: PlatformRun) => r.status === 'suspended' && !r.stopping;

  return (
    <div>
      {unreadable.length > 0 && <div role="alert" className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p>{unreadable.length} unreadable run record(s) were omitted. Other records remain available. No data was changed.</p>
        <details><summary className="cursor-pointer">Show unreadable record locations</summary>
          <ul>{unreadable.map(item => <li key={item.path} className="break-all"><code>{item.path}</code>: {item.error}</li>)}</ul>
        </details>
      </div>}
      <div className="flex justify-between items-center mb-2 text-sm text-gray-500"><span>{total} runs</span><button className="underline" onClick={onRefresh}>Refresh runs</button></div>
      <div role="region" aria-label="Run history table" tabIndex={0} className="surface max-w-full overflow-x-auto focus-visible:ring-2 focus-visible:ring-blue-500">
      <table className="run-table w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500 text-xs uppercase">
            <th className="py-2 pr-3">Run</th>
            <th className="py-2 pr-3">Workflow</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Working directory</th>
            <th className="py-2 pr-3">Created</th>
            <th className="py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && <tr><td colSpan={6} className="py-5 text-gray-500"><span role="status">{unreadable.length ? 'No readable runs available for this view. Review the unreadable records above.' : hasFilters ? 'No runs match these filters. Adjust the filters or start a workflow.' : 'No runs yet. Start a workflow from the Workflow library, or create your first workflow.'}</span><div className="mt-2 flex gap-3"><Link className="text-teal-700 underline" to="/intents">Open Workflow library</Link><Link className="text-teal-700 underline" to="/translate">Create workflow</Link></div></td></tr>}
          {runs.map(r => (
            <tr key={r.run_id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="py-2 pr-3 font-mono text-xs text-teal-700"><Link to={`/runs/${r.run_id}`}>{r.run_id}</Link></td>
              <td className="py-2 pr-3"><Link className="subtle-link font-medium" to={workflowLibraryHref(r)} title="View workflow definition">{r.workflowName ?? r.intent}</Link></td>
              <td className="py-2 pr-3">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[r.stopping ? 'stopping' : r.status] ?? ''}`}>{r.stopping ? 'stopping' : r.status}{r.orphaned ? ' (orphaned)' : ''}</span>
              </td>
              <td className="py-2 pr-3 text-xs text-gray-500 max-w-32 truncate" title={r.workdir}>{r.workdir}</td>
              <td className="py-2 pr-3 text-xs text-gray-500">{new Date(r.created_at).toLocaleString()}</td>
              <td className="py-2 flex gap-1">
                {hasPendingHuman(r) && <button onClick={() => nav(`/runs/${r.run_id}/human`)} className="text-xs px-2 py-0.5 rounded bg-orange-100 text-orange-700 hover:bg-orange-200">Respond</button>}
                {canRetry(r) && <button onClick={() => setRetryRun(r)} className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700 hover:bg-gray-200">Run again</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {retryRun && <RunTriggerDialog open onOpenChange={open => { if (!open) setRetryRun(null); }}
        retryDefaults={{ ittPath: retryRun.ittPath!, workdir: retryRun.workdir, inputs: retryRun.inputs ?? {},
          ...(retryRun.inputEncoding ? { inputEncoding: retryRun.inputEncoding } : {}) }} />}
      {totalPages > 1 && (
        <div className="flex gap-1 mt-3 justify-center">
          <button disabled={page === 1} onClick={() => onPageChange(page - 1)} className="px-2 py-1 text-sm border rounded disabled:opacity-40">←</button>
          <span className="px-3 py-1 text-sm">{page} / {totalPages}</span>
          <button disabled={page === totalPages} onClick={() => onPageChange(page + 1)} className="px-2 py-1 text-sm border rounded disabled:opacity-40">→</button>
        </div>
      )}
    </div>
  );
}
