import {FailureOutput} from './FailureOutput';
import {AiOutput} from './AiOutput';
import {useEffect, useRef, useState} from 'react';
import {useRunEvents} from '../hooks/useRunEvents';
import {currentRunAiHealth, type AiHealth} from '../api/aiHealth';
import {AiHealthSummary} from './AiHealthSummary';
import {CodeViewer} from './CodeViewer';
import {ValueViewer} from './ValueViewer';
import {buildExecutionActivity, currentRunFailure, type ActivityItem} from '../lib/execution-presentation';
import type {CFGNode, LogEvent} from '../lib/trace-layout';

import type {HumanHistoryItem} from '../api/human';
import {useRunArtifact} from '../hooks/useRunArtifact';
import {decodeNodeIo} from '../api/run-artifacts';
import {StepTiming} from './StepTiming';
import {elapsedTime} from '../lib/execution-time';
import {executionFrames} from '../lib/execution-frames';
interface Props {humanHistory?: HumanHistoryItem[];runId: string; onDone?: () => void; authoritativeEvents?: unknown[]; runStatus?: string; humanSubmissionAccepted?: boolean; nodes?: Record<string, CFGNode>;}
function ActivityStep({row, runId, events, health, live, workflow}: {row:ActivityItem; runId:string; events:LogEvent[]; health?:AiHealth; live:boolean; workflow?:string}) {
  const [open,setOpen] = useState(false);
  const io = useRunArtifact(open && row.kind === 'call' && (row.inputs === undefined || row.status === 'failed') && row.nodeRunId ? `/api/runs/${encodeURIComponent(runId)}/node/${encodeURIComponent(row.nodeRunId)}/io` : undefined, decodeNodeIo);
  const inputs = row.inputs ?? io.data?.inputs;
  const outputs = row.outputs ?? io.data?.outputs;
  const actor = row.executor === 'ai' ? 'AI' : row.executor === 'human' ? 'Human' : row.executor === 'code' ? 'Code' : row.kind === 'call' ? 'Workflow' : row.kind === 'unknown' ? 'Step' : 'Control';
  const output = row.executor === 'ai' && row.nodeRunId ? events.filter(event => event.event === 'ai_progress' && event.node_run_id === row.nodeRunId).map(event => String(event.message ?? '')).join('') : '';
  const elapsed = row.status === 'suspended' ? undefined : elapsedTime(row.startedAt,row.endedAt);
  return <li className="activity-row">
    <span className="activity-marker" data-status={row.status} aria-hidden="true">{row.status === 'completed' ? '✓' : row.status === 'failed' ? '!' : row.status === 'suspended' ? 'Ⅱ' : '•'}</span>
    <div className="activity-body">{workflow&&<p className="mb-1 text-xs text-teal-800 break-words">{workflow}</p>}<details onToggle={e => { if (e.target === e.currentTarget) setOpen(e.currentTarget.open); }}>
      <summary className="list-none group"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-ink break-all">{row.title}</span><span className="actor-badge" data-actor={row.executor}>{actor}</span><span className="text-xs text-muted ml-auto">{row.status === 'aborted' ? 'Stopped' : row.status === 'resuming' ? 'Continuing' : row.status === 'suspended' ? 'Waiting for your response' : row.status === 'completed' ? 'Completed' : row.status === 'failed' ? 'Failed' : 'In progress'}</span>{elapsed && <span className="text-xs text-muted tabular-nums" title={row.executor === 'human' ? 'Elapsed time, including waiting for your response' : 'Elapsed time'}>{elapsed}</span>}<span className="text-muted group-open:rotate-90" aria-hidden="true">›</span></div>
      {row.description && <p className="mt-1 text-sm text-muted max-w-[75ch] whitespace-pre-wrap line-clamp-2">{row.description}</p>}
      {row.kind === 'if' && typeof (row.outputs as {condition_result?: unknown})?.condition_result === 'boolean' && <p className="mt-1 text-sm text-muted">Condition: {(row.outputs as {condition_result:boolean}).condition_result ? 'true' : 'false'}</p>}
      </summary>
      <div className="mt-3 rounded-md border border-line p-4 bg-white space-y-4">
        {io.loading && <p role="status" className="text-sm text-muted">Loading inputs…</p>}
        {io.error && <p role="alert" className="text-sm text-red-700">Could not load step data: {io.error} <button className="underline" onClick={io.retry}>Retry</button></p>}
        {inputs !== undefined && <section><h3 className="text-sm font-semibold mb-2">Inputs</h3><ValueViewer value={inputs} /></section>}
        {outputs !== undefined && outputs !== null && <section><h3 className="text-sm font-semibold mb-2">{actor === 'Control' ? 'Result' : `${actor} result`}</h3><ValueViewer value={outputs} /></section>}
        {outputs === undefined && row.status === 'suspended' && <p className="text-sm text-muted">Waiting for your response. The result will appear here after submission.</p>}
        {outputs == null && row.status === 'failed' && <FailureOutput data={io.data ?? {error: row.error}} />}
        <StepTiming start={row.startedAt} end={row.status === 'suspended' ? undefined : row.endedAt} human={row.executor === 'human'} />
        <details className="text-sm"><summary className="text-muted">Technical details</summary><CodeViewer code={JSON.stringify({nodeId:row.nodeId,nodeRunId:row.nodeRunId,frameId:row.frameId,events:row.sourceEventIndexes.map(i => events[i])},null,2)} /></details>
      </div>
    </details>
    {row.executor === 'ai' && <>
      {live && health && <div className="mt-3"><AiHealthSummary health={health} label={row.title} /></div>}
      <AiOutput text={output} live={live} />
    </>}
    {row.error && <p role="alert" className="mt-2 rounded border border-red-200 bg-red-50 p-3 text-red-800 whitespace-pre-wrap break-words">{row.error}</p>}</div>
  </li>;
}
export function RunEventStream({runId, onDone, authoritativeEvents, runStatus, humanSubmissionAccepted, nodes, humanHistory}: Props) {
  const stream = useRunEvents(runId);
  const latest = useRef<HTMLDivElement>(null);
  useEffect(() => {if (stream.done) onDone?.();}, [stream.done, onDone]);
  const disk = (authoritativeEvents ?? []) as LogEvent[];
  const live = stream.events.filter(e => e.type === 'event').map(e => e.event) as LogEvent[];
  const seen = new Set(disk.map(event => JSON.stringify(event)));
  const events = [...disk, ...live.filter(event => !seen.has(JSON.stringify(event)))];
  const rows = buildExecutionActivity(events, nodes, false, humanHistory);
  const frames = new Map(executionFrames(events).map(frame=>[frame.id,frame]));
  const health = currentRunAiHealth(events, runStatus);
  const result = [...events].reverse().find(e => e.event === 'run_complete');
  const failure = currentRunFailure(events);
  const failureReason = failure ? String(failure.reason ?? failure.error ?? 'Execution stopped. Review the run status for details.') : undefined;
  return <div className="max-w-4xl">
    <div className="flex items-center justify-between mb-6 gap-4"><p className="text-sm text-muted">Open a step to see its inputs and result.</p><button type="button" className="subtle-link text-sm whitespace-nowrap" onClick={() => latest.current?.scrollIntoView({block:'nearest'})}>Latest step</button></div>
    {!rows.length && <p role="status" className="py-8 text-muted">{runStatus === 'running' ? 'The run has started. Waiting for its first step…' : 'No step activity was recorded.'}</p>}
    <ol className="activity-list">{rows.map(row => {const frame=frames.get(row.frameId ?? '');return <ActivityStep key={row.key} row={row} runId={runId} events={events} workflow={frame?.parentId?`${frame.title} · Call ${frame.call}`:undefined} health={row.nodeRunId ? health.get(row.nodeRunId) : undefined} live={row.executor === 'ai' && row.status === 'running' && (!runStatus || runStatus === 'running')} />;})}</ol>
    {failureReason && !rows.some(row => row.error === failureReason) && <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-red-800 whitespace-pre-wrap">{failureReason}</p>}
    {result?.outputs !== undefined && <section className="surface p-5 mb-5"><h2 className="font-semibold mb-3">Workflow result</h2><ValueViewer value={result.outputs} /></section>}
    <div ref={latest} />
    {runStatus === 'suspended' && <p role="status" className="mb-4 text-amber-900">{humanSubmissionAccepted ? 'Your answer was saved. Waiting for continuation; updates continue automatically.' : 'Waiting for human input. Complete the task above to continue.'}</p>}
    <details className="border-t border-line pt-4 text-sm"><summary className="text-muted">Raw execution log ({events.length} events)</summary><div className="max-h-96 overflow-auto mt-3"><CodeViewer code={events.map(e => JSON.stringify(e)).join('\n')} /></div></details>
  </div>;
}
