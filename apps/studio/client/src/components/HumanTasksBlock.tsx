import {ValueViewer} from './ValueViewer';
// platform/client/src/components/HumanTasksBlock.tsx
import {StepTiming} from './StepTiming';
import {elapsedTime} from '../lib/execution-time';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {describeNode} from '../lib/execution-presentation';
import type {CFGNode} from '../lib/trace-layout';
import type { HumanHistoryItem } from '../api/human';

interface Props {
  runId: string;
  history: HumanHistoryItem[];
  runStatus: string;
  nodes?: Record<string, CFGNode>;
  rootFrameId?: string;
}

function HistoryItem({ item, runStatus, title }: { item: HumanHistoryItem; runStatus: string; title?: string }) {
  const [expanded, setExpanded] = useState(false);
  const preparing = item.status === 'incomplete' && runStatus === 'running';
  const status = preparing ? 'preparing' : item.status;
  return (
    <div className="border border-gray-200 rounded mb-2">
      <button
        className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 rounded"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <span className="text-gray-600 text-xs">{expanded ? '▾' : '▶'}</span>
        <span className="text-sm font-semibold text-ink break-words">{title ?? item.nodeId.replace(/^call_/, '').replace(/_\d+$/, '')}</span>
        <span className="text-xs text-gray-600 ml-auto">{elapsedTime(Date.parse(item.startedAt)/1000, item.completedAt ? Date.parse(item.completedAt)/1000 : undefined) ?? 'In progress'}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded ${preparing ? 'bg-blue-100 text-teal-800' : item.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{status}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-gray-100">
          {preparing && <p role="status" className="pt-2 text-sm text-blue-800">Preparing this human task. Its controls will appear when it is ready.</p>}
          <div className="pt-2">
            <div className="text-sm font-semibold text-ink mb-2">Prompt</div>
            <div className="text-sm text-gray-800">{item.prompt}</div>
          </div>
          {item.error && <p className="text-sm text-red-600">{item.error}</p>}
          {Object.keys(item.resolvedInputs).length > 0 && (
            <div>
              <div className="text-sm font-semibold text-ink mb-2">Inputs</div>
              <ValueViewer value={item.resolvedInputs} />
            </div>
          )}
          {item.result && Object.keys(item.result).length > 0 && (
            <div>
              <div className="text-sm font-semibold text-ink mb-2">Human result</div>
              <ValueViewer value={item.result} />
            </div>
          )}
          <StepTiming start={Date.parse(item.startedAt)/1000} end={item.completedAt ? Date.parse(item.completedAt)/1000 : undefined} human />
        </div>
      )}
    </div>
  );
}

function PendingItem({ item, runId, canResume, runStatus, title }: { item: HumanHistoryItem; runId: string; canResume: boolean; runStatus: string; title?:string }) {
  const nav = useNavigate();
  const ended=['failed','aborted','completed'].includes(runStatus);
  return (
    <div className="border border-orange-300 rounded mb-2 bg-orange-50">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-orange-200">
        <span className="text-xs font-mono text-orange-800">{title ?? item.nodeId.replace(/^call_/, '').replace(/_\d+$/, '')}</span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 ml-auto">{ended ? 'Closed' : item.acceptedSubmission ? 'submitted' : canResume ? 'pending' : 'suspended'}</span>
      </div>
      <div className="px-3 py-3 space-y-3">
        {ended&&!item.acceptedSubmission&&<p className="text-sm text-muted">This run has ended. No answer is needed.</p>}
        {item.acceptedSubmission && <p role="status" className="text-sm text-blue-800">Your answer was saved. {['failed', 'aborted', 'completed'].includes(runStatus)
          ? `This run is ${runStatus}. It is not waiting for another answer.`
          : 'Waiting for continuation; you do not need to answer again.'}</p>}
        <div>
          <div className="text-sm font-semibold text-ink mb-2">Prompt</div>
          <div className="text-sm text-gray-800">{item.prompt}</div>
        </div>
        {Object.keys(item.resolvedInputs).length > 0 && (
          <div>
            <div className="text-sm font-semibold text-ink mb-2">Inputs</div>
            <ValueViewer value={item.resolvedInputs} />
          </div>
        )}
        {item.outputTypes.length > 0 && (
          <div>
            <div className="text-sm font-semibold text-ink mb-2">Expected outputs</div>
            <div className="flex flex-wrap gap-2">
              {item.outputTypes.map(o => (
                <span key={o.name} className="text-xs font-mono px-1.5 py-0.5 bg-white border border-gray-200 text-gray-600 rounded">
                  {o.name}: <span className="text-gray-600">{o.kind}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        <button
          disabled={!canResume}
          onClick={() => nav(`/runs/${runId}/human`)}
          className="px-3 py-1.5 text-sm rounded bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {item.acceptedSubmission ? 'View continuation' : 'Respond'}
        </button>
      </div>
    </div>
  );
}

export function HumanTasksBlock({ runId, history, runStatus, nodes, rootFrameId }: Props) {
  if (history.length === 0) return null;

  const completed = history.filter(h => h.status === 'completed');
  const pending   = history.filter(h => h.status === 'suspended');

  const unfinished = history.filter(h => h.status === 'failed' || h.status === 'incomplete');

  return (
    <div className="px-4 py-3 border-b border-gray-200">
      <h2 className="text-sm font-semibold text-muted mb-2">Human input</h2>
      {/* Pending (expanded by default, shown first) */}
      {pending.map(item => (
        <PendingItem key={item.nodeRunId} item={item} runId={runId} canResume={runStatus === 'suspended'} runStatus={runStatus} title={rootFrameId && item.frameId === rootFrameId && nodes?.[item.nodeId] ? describeNode(nodes[item.nodeId]).title : undefined} />
      ))}
      {unfinished.map(item => <HistoryItem key={item.nodeRunId} item={item} runStatus={runStatus} title={rootFrameId && item.frameId === rootFrameId && nodes?.[item.nodeId] ? describeNode(nodes[item.nodeId]).title : undefined} />)}
      {/* Completed (collapsed by default) */}
      {completed.length > 0 && <details className="text-sm"><summary className="text-muted mb-2">Completed human input ({completed.length})</summary>{completed.map(item => (
        <HistoryItem key={item.nodeRunId} item={item} runStatus={runStatus} title={rootFrameId && item.frameId === rootFrameId && nodes?.[item.nodeId] ? describeNode(nodes[item.nodeId]).title : undefined} />
      ))}</details>}
    </div>
  );
}
