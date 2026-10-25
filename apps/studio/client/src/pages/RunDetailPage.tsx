import {ValueViewer} from '../components/ValueViewer';
import {FailureOutput} from '../components/FailureOutput';
// platform/client/src/pages/RunDetailPage.tsx
import * as Dialog from '@radix-ui/react-dialog';
import { Link, useParams } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { getRun, abortRun, resumeRun, RunReadError, type PlatformRun } from '../api/runs';
import { RunEventStream } from '../components/RunEventStream';
import { CodeViewer } from '../components/CodeViewer';
import { RunTriggerDialog } from '../components/RunTriggerDialog';
import { AiQuestionsBlock } from '../components/AiQuestionsBlock';
import { HumanTasksBlock } from '../components/HumanTasksBlock';
import { type LogEvent, type CFGNode } from '../lib/trace-layout';
import { useHumanHistory } from '../hooks/useHumanHistory';
import { useRunArtifact } from '../hooks/useRunArtifact';
import { workflowLibraryHref } from '../lib/workflow-links';
import { ExecutionGraph } from '../components/ExecutionGraph';
import { buildExecutionPath, type ExecutionPathStep } from '../lib/execution-path';
import { ExecutionStepSummary } from '../components/ExecutionStepSummary';
import { decodeSnapshot, decodeSource, decodeNodeIo } from '../api/run-artifacts';
import {AiOutput} from '../components/AiOutput';

// ── Component ─────────────────────────────────────────────────────────────────

export function RunDetailPage() {
  const { id: runId } = useParams<{ id: string }>();
  return <RunDetail key={runId} runId={runId} />;
}

function ReadFailure({ label, error, retry }: { label: string; error: string; retry(): void }) {
  return <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
    <p>Unable to load {label}: {error}</p>
    <button onClick={retry} className="mt-2 rounded border border-red-400 px-2 py-1">Retry loading {label}</button>
  </div>;
}

function RunDetail({ runId }: { runId?: string }) {
  const [run, setRun] = useState<(PlatformRun & { events: unknown[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadAttempt, setReloadAttempt] = useState(0);
  const [readFailures, setReadFailures] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number>();
  const [abortBusy, setAbortBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const resumeInFlight = useRef(false);
  const abortInFlight = useRef(false);
  const currentRunId = useRef(runId);
  currentRunId.current = runId;
  const [now, setNow] = useState(Date.now());

  const [activeTab, setActiveTab] = useState<'events' | 'flow' | 'json' | 'ts'>('events');
  const snapshotRead = useRunArtifact(runId ? `/api/runs/${encodeURIComponent(runId)}/snapshot` : undefined, decodeSnapshot);
  const snapshot = snapshotRead.data;
  const sourceRead = useRunArtifact(runId && activeTab === 'ts' ? `/api/runs/${encodeURIComponent(runId)}/ts-source` : undefined, decodeSource);
  const [retryOpen, setRetryOpen] = useState(false);

  const [selectedStep, setSelectedStep] = useState<ExecutionPathStep | null>(null);
  function closeNodeDetails() { setSelectedStep(null); }

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setReadFailures(0); setLastSyncedAt(undefined);
    setRun(null); setError(null); setAbortBusy(false); abortInFlight.current = false; setSelectedStep(null);
    // Event streaming can close after suspension, or before the final run.json
    // update. Refresh authoritative status independently of the active tab/SSE.
    async function refresh() {
      let again = true;
      try {
        const next = await getRun(runId!, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
        if (cancelled) return;
        setRun(next); setReadFailures(0); setLastSyncedAt(Date.now());
        const stopResolved = next.stopping || ['completed', 'failed', 'aborted'].includes(next.status);
        setError(previous => previous?.startsWith('Unable to refresh run:') ||
          (stopResolved && previous?.startsWith('Stop acknowledgement unavailable:')) ? null : previous);
        again = Boolean(next.stopping || next.workerActive) || next.status === 'running' || next.status === 'suspended';
      } catch (error) {
        if (cancelled) return;
        again = !(error instanceof RunReadError && error.status === 404);
        setReadFailures(value => value + 1);
        setError(`Unable to refresh run: ${error instanceof Error && error.name === 'TimeoutError' ? 'The server did not respond within 15 seconds.' : error instanceof Error ? error.message : String(error)}`);
      }
      if (again && !cancelled) timer = setTimeout(refresh, 2000);
    }
    void refresh();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [runId, reloadAttempt]);


  const humanHistory = useHumanHistory(runId ?? '', run?.status ?? '');
  const recordedSteps = selectedStep && snapshot && run ? buildExecutionPath(snapshot.nodes as Record<string, CFGNode>, run.events as LogEvent[], humanHistory.history, true, selectedStep.row.frameId).steps : [];
  const inspectedStep = recordedSteps.find(step => step.row.key === selectedStep?.row.key) ?? selectedStep;
  const artifactId = inspectedStep?.row.nodeRunId;
  const ioRead = useRunArtifact(runId && activeTab === 'flow' && artifactId ? `/api/runs/${encodeURIComponent(runId)}/node/${encodeURIComponent(artifactId)}/io` : undefined, decodeNodeIo, `${run?.status}:${inspectedStep?.row.status}:${inspectedStep?.row.sourceEventIndexes.length}`);
  const stopping = run?.stopping;
  const canAbort = run?.status === 'running' || run?.status === 'suspended' || Boolean(stopping?.error);
  useEffect(() => {
    if (!stopping) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stopping?.requestedAt]);

  async function doResume() {
    if (!run?.resumeFailure || resumeInFlight.current) return;
    setResumeOpen(false);
    resumeInFlight.current = true; setResumeBusy(true); setError(null);
    try {
      await resumeRun(run.run_id, undefined, run.resumeFailure.nodeRunId);
      setReloadAttempt(value => value + 1);
    } catch (error) {
      // A lost POST receipt must not invite a second execution. Reconcile with
      // persisted status before showing a failure; never retry the POST here.
      try {
        const next = await getRun(run.run_id, undefined, AbortSignal.timeout(15000));
        if (next.status !== 'failed' || next.resumeFailure?.nodeRunId !== run.resumeFailure.nodeRunId) {
          setReloadAttempt(value => value + 1);
          return;
        }
        setRun(next);
      } catch { /* Keep the uncertain-outcome message and allow a manual refresh. */ }
      setError(`Resume acknowledgement unavailable: ${error instanceof Error ? error.message : String(error)}. Check the latest run status before trying again.`);
    }
    finally { resumeInFlight.current = false; setResumeBusy(false); }
  }

  async function doAbort() {
    if (!run || abortInFlight.current) return;
    const id = run.run_id;
    abortInFlight.current = true;
    setAbortBusy(true); setError(null);
    try {
      await abortRun(id);
      const next = await getRun(id, undefined, AbortSignal.timeout(15000));
      if (currentRunId.current === id) setRun(next);
    } catch (e) {
      // Completion may win the race, or the stop receipt may have been lost.
      // A fresh persisted state is stronger evidence than the POST error.
      try {
        const next = await getRun(id, undefined, AbortSignal.timeout(15000));
        if (currentRunId.current !== id) return;
        setRun(next);
        if (next.stopping || ['completed', 'failed', 'aborted'].includes(next.status)) { setError(null); return; }
      } catch { /* Keep the unknown-outcome message until polling can reconcile. */ }
      if (currentRunId.current === id) setError(`Stop acknowledgement unavailable: ${String(e)}. The request may have been accepted; status updates continue automatically.`);
    } finally {
      if (currentRunId.current === id) { setAbortBusy(false); abortInFlight.current = false; }
    }
  }

  if (!run) return <div className="p-4 text-sm">
    <p className="mb-2 text-gray-600">Run: {runId}</p>
    {error ? <ReadFailure label="run" error={error.replace(/^Unable to refresh run: /, '')} retry={() => setReloadAttempt(value => value + 1)} />
      : <p role="status" className="text-gray-500">Loading run…</p>}
    {readFailures > 1 && <p role="status" className="mt-2 text-amber-800">Status updates are disconnected ({readFailures} failed reads). Retrying automatically.</p>}
    <Link className="mt-3 inline-block text-teal-700 underline" to="/history">Back to run history</Link>
  </div>;

  const continuing = run.status === 'suspended' && humanHistory.history.some(item => item.status === 'suspended' && item.acceptedSubmission);
  const inspectedCalls = inspectedStep ? recordedSteps.filter(step => step.row.nodeId === inspectedStep.row.nodeId) : [];
  const inspectedCallIndex = inspectedCalls.findIndex(step => step.row.key === inspectedStep?.row.key);
  const inspectedCallLabel = inspectedStep?.iteration ? `Iteration ${inspectedStep.iteration}` : inspectedStep?.exit ? 'Loop exit' : inspectedCallIndex >= 0 ? `Call ${inspectedCallIndex + 1} of ${inspectedCalls.length}` : 'Recorded step';
  const inspectedAiOutput = inspectedStep?.row.executor==='ai' ? (run.events as LogEvent[]).filter(event=>event.event==='ai_progress'&&event.node_run_id===inspectedStep.row.nodeRunId).map(event=>String(event.message ?? '')).join('') : '';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="run-heading">
        <div className="run-heading-main">
          <div className="flex flex-wrap items-center gap-3 mb-2"><span className="run-identity">Run {run.run_id.replace(/^run_/, '')}</span><span className="status-chip" data-status={stopping || continuing ? 'running' : run.status}>{stopping ? 'Stopping' : continuing ? 'Continuing' : run.status === 'suspended' ? 'Waiting for input' : run.status[0].toUpperCase()+run.status.slice(1)}{readFailures > 0 ? ' (last known)' : ''}{run.orphaned ? ' (orphaned)' : ''}</span></div>
          <h1><Link to={workflowLibraryHref(run)} title="Open workflow in library">{run.workflowName ?? run.intent}</Link></h1>
          <div className="run-metadata"><span>Started <time dateTime={run.created_at}>{new Date(run.created_at).toLocaleString()}</time></span><span>{run.triggeredBy === 'schedule' ? 'Scheduled run' : run.triggeredBy === 'manual' ? 'Manual run' : 'Trigger not recorded'}</span></div>
          <details className="text-xs text-muted mt-3 break-all"><summary>Run details</summary><dl className="mt-2 space-y-1"><div>Run ID: <span className="font-mono">{run.run_id}</span></div><div>Working directory: {run.workdir}</div></dl></details>
        </div>
        <div className="run-heading-actions">
          {run.resumeFailure && !stopping && <button className="primary-action" onClick={() => setResumeOpen(true)} disabled={resumeBusy}>{resumeBusy ? 'Resuming…' : 'Resume failed step'}</button>}
          {run.ittPath && !stopping && !abortBusy && <button onClick={() => setRetryOpen(true)} className="primary-action">Run again</button>}
          {canAbort && <button onClick={doAbort} disabled={abortBusy || Boolean(stopping && !stopping.error)} className="px-3 py-2 text-sm rounded border border-red-300 text-red-700 hover:bg-red-50">{abortBusy ? 'Requesting stop…' : stopping?.error ? 'Retry stop' : stopping ? 'Stopping…' : 'Stop run'}</button>}
        </div>
        {run.failReason && (
          <div className="col-span-full text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mb-3 font-mono whitespace-pre-wrap">
            {run.failReason}
          </div>
        )}
        {error && <div role="alert" className="text-red-600 text-sm mb-2">
          <p>{error}</p>
          {readFailures > 0 && <p>
            {readFailures > 1 ? `Status updates are disconnected (${readFailures} failed reads).` : 'The latest status could not be read.'}
            {' '}Displayed status may be out of date; retrying automatically.
            {lastSyncedAt && ` Last successful update: ${new Date(lastSyncedAt).toLocaleTimeString()}.`}
          </p>}
        </div>}

      </div>

      {(abortBusy || stopping) && <div role="status" className="mx-4 mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        {stopping ? `Stopping · ${Math.max(0, Math.floor((now - Date.parse(stopping.requestedAt)) / 1000))}s` : 'Requesting stop…'}
        <p>Waiting for the worker and its AI execution to finish cleanup. The run is not confirmed stopped yet.</p>
        {stopping && now - Date.parse(stopping.requestedAt) > 15000 && <p>Taking longer than usual. Cleanup has not finished; updates continue automatically.</p>}
        {stopping?.error && <p role="alert">{stopping.error}</p>}
      </div>}
      <AiQuestionsBlock key={run.run_id} runId={run.run_id} runStatus={stopping || abortBusy ? 'stopping' : run.status} />

      {/* Human Tasks block */}
      {humanHistory.error && <p role="alert" className="px-4 py-2 text-sm text-red-600">{humanHistory.error} Displayed tasks may be out of date.</p>}
      <HumanTasksBlock rootFrameId={(run.events as LogEvent[]).find(event => event.event === 'node_pending')?.frame_id as string | undefined} nodes={snapshot?.nodes as Record<string, CFGNode> | undefined} runId={run.run_id} history={humanHistory.history} runStatus={humanHistory.error || stopping || abortBusy ? 'unknown' : run.status} />

      {/* Tab bar */}
      <div className="flex shrink-0 overflow-x-auto border-b border-gray-200 px-4">
        {(['events', 'flow', 'ts', 'json'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`shrink-0 whitespace-nowrap px-4 py-2 text-sm border-b-2 ${activeTab === tab ? 'border-blue-300 text-teal-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {tab === 'events' ? 'Activity' : tab === 'flow' ? 'Execution' : tab === 'json' ? 'Workflow JSON' : 'TypeScript'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'events' && (
        <div className="flex-1 overflow-auto p-4">
          <RunEventStream humanHistory={humanHistory.history} nodes={snapshot?.nodes as Record<string, CFGNode> | undefined} humanSubmissionAccepted={humanHistory.history.some(item => item.status === 'suspended' && Boolean(item.acceptedSubmission))} key={run.run_id} runId={run.run_id} authoritativeEvents={run.events} runStatus={stopping || abortBusy ? 'stopping' : run.status} />
        </div>
      )}

      {activeTab === 'flow' && (
        <div className="p-4 min-w-0">
          {snapshotRead.error ? <ReadFailure label="snapshot" error={snapshotRead.error} retry={snapshotRead.retry} />
            : !snapshotRead.loading && snapshot ? <ExecutionGraph runId={run.run_id} nodes={snapshot.nodes as Record<string, CFGNode>} entry={snapshot.entry} events={(run.events ?? []) as LogEvent[]} history={humanHistory.history} selectedStepKey={selectedStep?.row.key} onViewChange={closeNodeDetails} onStepClick={setSelectedStep}
              inspector={{selectionKey: inspectedStep?.row.key,
                title: inspectedStep?.row.title,
                subtitle: inspectedStep ? inspectedCallLabel : undefined,
                onClose: closeNodeDetails,
                details: <>
                  {inspectedStep?.row.error && <p role="alert" className="mb-4 text-sm text-red-700 whitespace-pre-wrap">{inspectedStep.row.error}</p>}
                  {inspectedStep?.row.executor==='ai'&&<AiOutput key={inspectedStep.row.key} text={inspectedAiOutput} live={run.status==='running'&&inspectedStep.row.status==='running'} />}
                  {inspectedStep && inspectedStep.row.kind !== 'call' && <ExecutionStepSummary step={inspectedStep} />}
                  {!artifactId ? (inspectedStep?.row.kind === 'call' && <p className="text-sm text-muted">This recorded step has no separate input/output snapshot.</p>) : ioRead.error ? <ReadFailure label="node details" error={ioRead.error} retry={ioRead.retry} />
                    : ioRead.loading ? <p role="status">Loading step details…</p>
                    : <><h4>Inputs</h4><ValueViewer value={ioRead.data?.inputs} />
                      <h4>Outputs</h4>{ioRead.data?.outputs == null ? inspectedStep?.row.status === 'failed' ? <FailureOutput data={ioRead.data} /> : <p className="text-sm text-muted">No output recorded for this step.</p> : <ValueViewer value={ioRead.data.outputs} />}</>}
                </>,
              }} />
            : <p role="status">Loading snapshot…</p>}

        </div>
      )}

      {activeTab === 'json' && (
        <div className="flex-1 overflow-auto p-4">
          {snapshotRead.error ? (
            <ReadFailure label="snapshot" error={snapshotRead.error} retry={snapshotRead.retry} />
          ) : snapshot ? (
            <CodeViewer code={JSON.stringify(snapshot, null, 2)} lang="json" />
          ) : (
            <div className="text-sm text-gray-500">Loading snapshot…</div>
          )}
        </div>
      )}

      {activeTab === 'ts' && (
        <div className="flex-1 overflow-auto p-4">
          {sourceRead.error ? <ReadFailure label="source" error={sourceRead.error} retry={sourceRead.retry} />
            : sourceRead.loading ? <div role="status" className="text-sm text-gray-500">Loading TS source…</div>
            : sourceRead.data !== undefined && <CodeViewer code={sourceRead.data} lang="typescript" />}

        </div>
      )}

      <Dialog.Root open={resumeOpen} onOpenChange={setResumeOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[90vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl">
            <Dialog.Title className="text-lg font-semibold">Resume failed step</Dialog.Title>
            <Dialog.Description className="mt-3 text-sm text-muted">Continue with this run’s saved workflow and inputs. Completed steps will not run again. The failed step may repeat actions it performed before failing.</Dialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <Dialog.Close className="secondary-action">Cancel</Dialog.Close>
              <button className="primary-action" onClick={doResume} disabled={resumeBusy}>Resume</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {/* Retry dialog */}
      <RunTriggerDialog
        open={retryOpen}
        onOpenChange={setRetryOpen}
        retryDefaults={{
          ittPath: run.ittPath ?? '',
          workdir: run.workdir ?? '',
          inputs: run.inputs ?? {},
          inputEncoding: run.inputEncoding,
        }}
      />
    </div>
  );
}
