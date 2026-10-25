import {AiOutput} from '../components/AiOutput';
import { QuestionAnswerInput } from '../components/QuestionAnswerInput';
// platform/client/src/pages/TranslatePage.tsx
import { useState, useEffect } from 'react';
import { GenerationWaiting } from '../components/GenerationWaiting';
import { GenerationHistory } from '../components/GenerationHistory';
import { AiHealthSummary } from '../components/AiHealthSummary';
import { CodeViewer } from '../components/CodeViewer';
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useTranslate, type QAEntry } from '../hooks/useTranslate';
import { useQuestionDraft } from '../hooks/useQuestionDraft';
import type { SessionStep, SessionInput } from '../api/translate';
import {RunTriggerDialog} from '../components/RunTriggerDialog';
import {publishedWorkflows} from '../lib/published-workflows';

const DRAFT_KEY = 'intentorch.translate.draft';

// ─── Step indicator ────────────────────────────────────────────────────────────

const STEPS = [
  { n: 1, label: 'Describe' },
  { n: 2, label: 'Review Changes' },
  { n: 3, label: 'Done' },
];

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center px-4 py-3 border-b border-gray-200">
      {STEPS.map(({ n, label }, i) => {
        const done = n < current;
        return (
          <div key={n} className="flex items-center">
            {i > 0 && <div className="w-8 h-px bg-gray-600 mx-1" />}
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
              done ? 'bg-green-50 border-green-300 text-green-700'
                : n === current ? 'bg-blue-50 border-blue-300 text-blue-900'
                : 'bg-gray-50 border-gray-200 text-gray-500'
            }`}>
              {done ? '✓' : n}
            </div>
            <span className={`ml-1 text-xs ${
              n === current ? 'text-teal-800' : done ? 'text-green-700' : 'text-gray-500'
            }`}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Q&A History bubbles ────────────────────────────────────────────────────────

function QAHistory({ history }: { history: QAEntry[] }) {
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;
  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-xs text-gray-600 hover:border-gray-600 hover:text-gray-300"
      >
        <span>{open ? '▾' : '▸'}&nbsp;&nbsp;{history.length} answer{history.length > 1 ? 's' : ''} given — click to {open ? 'collapse' : 'review'}</span>
        <span className="px-2 py-0.5 bg-gray-50 rounded-full text-gray-500">history</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
          {history.map((h, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">❓ AI asked (Round {i + 1})</div>
                <div className="whitespace-pre-wrap break-words text-xs text-gray-600">{h.question}</div>
              </div>
              <div className="bg-blue-50/30 border border-blue-300 rounded-lg px-3 py-2">
                <div className="text-[10px] text-blue-500 uppercase tracking-wide mb-1">✓ You answered</div>
                <div className="whitespace-pre-wrap break-words text-xs text-teal-800">{h.answer}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Waiting / CC-thinking view ─────────────────────────────────────────────────

function WaitingView({ step, answering = false }: { step: SessionStep | null; answering?: boolean }) {
  const round = step?.phase === 'cc_running' ? step.round : null;
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="text-sm font-medium text-gray-600">
        {answering ? 'Continuing after your answer' : 'Generating workflow'}<span className="animate-pulse">…</span>
      </div>
      {step?.aiHealth && !(answering && step.aiHealth.phase === 'waiting_for_input')
        ? <AiHealthSummary health={step.aiHealth} dark /> : <GenerationWaiting answering={answering} />}
      {round != null && (
        <div className="flex flex-col items-center gap-1">
          <div className="text-xs text-gray-500">Generation round <span className="text-gray-600 font-medium">{round}</span></div>
          <div className="text-[11px] text-gray-600">This may take a minute…</div>
        </div>
      )}
    </div>
  );
}

// ─── Diff viewer ─────────────────────────────────────────────────────────────────

function DiffViewer({ filePath, diff }: { filePath: string; diff: string }) {
  const lines = diff.split('\n');
  return (
    <div className="text-xs font-mono">
      <div className="px-3 py-1 bg-gray-50 text-gray-600 border-b border-gray-200 rounded-t break-all">
        {filePath}
      </div>
      <div className="overflow-x-auto max-h-64 overflow-y-auto rounded-b border border-gray-200">
        {lines.map((line, i) => {
          const isAdd = line.startsWith('+') && !line.startsWith('+++');
          const isDel = line.startsWith('-') && !line.startsWith('---');
          const isHunk = line.startsWith('@@');
          return (
            <div
              key={i}
              className={`px-3 py-0 leading-5 whitespace-pre ${
                isAdd ? 'bg-green-50/40 text-green-700'
                  : isDel ? 'bg-red-50/40 text-red-700'
                  : isHunk ? 'bg-blue-50/20 text-teal-800'
                  : 'text-gray-600'
              }`}
            >
              {line || ' '}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Confirm Merge view ──────────────────────────────────────────────────────────

function ConfirmMergeView({
  sessionId,
  step,
  respond,
  loading,
}: {
  sessionId?: string;
  step: Extract<SessionStep, { phase: 'confirm_merge' }>;
  respond: (input: SessionInput) => Promise<boolean>;
  loading: boolean;
}) {
  const { preflight, entries } = step;
  const draft=useQuestionDraft(sessionId,step.reviewId ? `revision-${step.reviewId}` : undefined);
  return (
    <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto">
      {preflight.modified.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-yellow-700 font-semibold text-sm">
              ⚠ Modified intents — review required ({preflight.modified.length})
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {preflight.modified.map(file => (
              <div key={file}>
                <DiffViewer filePath={file} diff={preflight.diffs[file] ?? ''} />
                {preflight.contents?.[file] && <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-teal-800 break-all">Proposed TypeScript — {file}</summary>
                  <CodeViewer code={preflight.contents[file]} lang="typescript" className="mt-2 max-h-64" />
                </details>}
              </div>
            ))}
          </div>
        </div>
      )}

      {preflight.added.length > 0 && (
        <div>
          <div className="text-green-700 font-semibold text-sm mb-2">
            + New files ({preflight.added.length})
          </div>
          <div className="flex flex-col gap-3">
            {preflight.added.map(f => (
              <div key={f} className="min-w-0 text-xs font-mono">
                <div className="px-3 py-1 bg-gray-50 text-gray-600 border-b border-gray-200 rounded-t flex flex-wrap items-center gap-2">
                  <span className="text-green-700">+</span>
                  <span className="min-w-0 break-all">{f}</span>
                  {entries.some(e => f.includes(e)) && (
                    <span className="text-xs text-teal-800 px-1 bg-blue-50/30 rounded">entry</span>
                  )}
                </div>
                {preflight.contents?.[f] ? (
                  <CodeViewer code={preflight.contents[f]} lang="typescript" className="max-h-64 rounded-t-none border border-gray-200" />
                ) : (
                  <div className="px-3 py-2 rounded-b border border-gray-200 text-gray-500">(no content)</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <section className="rounded-lg border border-teal-200 bg-teal-50/40 p-4">
        <label htmlFor="workflow-feedback" className="block text-sm font-semibold mb-2">Continue with AI</label>
        <textarea id="workflow-feedback" rows={3} className="w-full rounded border border-line bg-white p-3 text-sm" placeholder="Describe what to change or clarify in this draft…" value={draft.text} disabled={loading} onChange={event=>draft.setText(event.target.value)} />
        <button className="primary-action mt-2" disabled={loading||!step.reviewId||!draft.text.trim()} onClick={()=>{void respond({type:'feedback',reviewId:step.reviewId!,message:draft.text}).then(accepted=>{if(accepted)draft.clear();});}}>Send changes</button>
        <p className="mt-2 text-xs text-muted">AI will update this draft. You can review it again before publishing.</p>
        {draft.unavailable&&<p role="status" className="text-xs text-amber-800">Draft storage is unavailable. Copy your message before leaving.</p>}
      </section>
      <div className="flex flex-wrap gap-3 mt-2">
        <button
          onClick={() => respond({ type: 'merge_approve', reviewId: step.reviewId })}
          disabled={loading || !step.reviewId}
          className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-sm rounded disabled:opacity-50"
        >
          {loading ? 'Publishing…' : 'Publish to library'}
        </button>
        <button
          onClick={() => respond({ type: 'merge_reject' })}
          disabled={loading}
          className="px-4 py-2 bg-gray-50 hover:bg-gray-600 text-gray-600 text-sm rounded disabled:opacity-50"
        >
          Discard changes
        </button>
      </div>
      {!step.reviewId && <p role="alert" className="text-sm text-amber-700">The review identity is unavailable. Reload this task with the current server before approving.</p>}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

function OriginalRequest({ text, history }: { text: string; history: QAEntry[] }) {
  if (!text && !history.length) return null;
  return <section aria-label="Your request" className="shrink-0 max-h-[45vh] overflow-y-auto border-b border-gray-200 bg-gray-50/50 px-4 py-3">
    <h2 className="mb-2 text-xs font-semibold text-gray-600">Your request</h2>
    <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-900">{text}</div>
    {history.length > 0 && <div className="mt-3"><QAHistory history={history} /></div>}
  </section>;
}

export function TranslatePage() {
  const { sid: urlSid } = useParams<{ sid?: string }>();
  const { step, loading, error, history, originalRequest, waitingForCC, start, respond, stop, resumeSession, reset, sessionId } = useTranslate();
  const navigate = useNavigate();
  const location = useLocation();
  const [runEntry,setRunEntry]=useState<string>();

  // Step 1 form state
  const [nl, setNl] = useState('');
  const [draftUnavailable, setDraftUnavailable] = useState(false);
  function saveDraft(value: string) {
    setNl(value);
    try {
      if (value) sessionStorage.setItem(DRAFT_KEY, value);
      else sessionStorage.removeItem(DRAFT_KEY);
      setDraftUnavailable(false);
    } catch { setDraftUnavailable(true); }
  }

  // MCP question state
  const answerDraft = useQuestionDraft(urlSid ?? sessionId,
    step?.phase === 'cc_waiting_for_answer' ? step.questionId : undefined);
  const { selectedOption: mcpSelectedOptionValue,
    text: mcpFreeText, setText: setMcpFreeText } = answerDraft;

  const [resumeError, setResumeError] = useState<string | null>(null);

  // Restore session from URL sid on mount
  useEffect(() => {
    setResumeError(null);
    if (!urlSid) {
      reset();
      if (typeof location.state?.naturalLanguage === 'string') {
        saveDraft(location.state.naturalLanguage);
        // Consume prefills so refreshing cannot overwrite subsequent edits.
        const { naturalLanguage: _prefill, ...state } = location.state;
        navigate(location.pathname, { replace: true, state });
      }
      else {
        try { setNl(sessionStorage.getItem(DRAFT_KEY) ?? ''); }
        catch { setDraftUnavailable(true); }
      }
    } else if (urlSid !== sessionId) {
      resumeSession(urlSid).catch(error => setResumeError(error instanceof Error ? error.message : String(error)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSid, location.key]);

  // ── Derived ─────────────────────────────────────────────────────────────────

  const phase = step?.phase ?? null;

  let currentVisualStep = 1;
  if (phase === 'cc_running' || phase === 'cc_waiting_for_answer' || phase === 'auto_fixing' || phase === 'confirm_merge') {
    currentVisualStep = 2;
  } else if (phase === 'done') {
    currentVisualStep = 3;
  }

  // ── Resume error ─────────────────────────────────────────────────────────────

  if (resumeError) {
    return (
      <div className="flex flex-col h-full text-gray-900">
        <StepIndicator current={1} />
        <div className="flex-1 p-6">
          <div role="alert" className="text-red-700 text-sm mb-3">Unable to load this saved task: {resumeError}</div>
          <p className="text-sm text-gray-600 mb-3">Retrying reads the saved task status. It does not start another AI task.</p>
          <button onClick={() => {
            if (!urlSid) return;
            setResumeError(null);
            void resumeSession(urlSid).catch(error => setResumeError(error instanceof Error ? error.message : String(error)));
          }} className="mr-3 px-3 py-1.5 text-sm rounded bg-teal-700 text-white hover:bg-teal-800">Retry loading task</button>
          <button onClick={() => navigate('/translate')} className="px-3 py-1.5 text-sm rounded bg-gray-50 text-gray-600 hover:bg-gray-600">
            ← Generation history
          </button>
        </div>
      </div>
    );
  }

  // ── Step 1: initial form ────────────────────────────────────────────────────

  if (!step) {
    return (
      <div className="flex flex-col h-full text-gray-900">
        <StepIndicator current={1} />
        <div className="flex-1 py-6">
          <header className="page-heading"><div><h1>Create workflow</h1><p>Describe the work. Review the TypeScript before adding it to your library.</p></div></header>
          <div className="create-workspace"><div className="surface p-6">
            <div className="flex items-center justify-between mb-3"><label htmlFor="workflow-request" className="font-semibold">What would you like to automate?</label>
              <span className="relative group"><button type="button" aria-label="About draft saving" aria-describedby="draft-help" className="rounded-full border border-line text-muted w-6 h-6 text-xs">?</button>
                <span id="draft-help" role="tooltip" className="hidden group-hover:block group-focus-within:block absolute right-0 top-8 z-10 w-64 rounded border border-line bg-white p-3 text-sm shadow-lg">Your draft stays in this tab when you navigate or refresh, until a task is created.</span>
              </span></div>
            <textarea
              id="workflow-request" aria-label="Automation request"
              aria-describedby={draftUnavailable ? 'draft-status' : undefined}
              className="w-full bg-gray-50 border border-gray-200 rounded px-3 py-2 text-sm mb-2 text-gray-900 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              rows={7}
              placeholder="Describe what you want to automate…"
              value={nl}
              disabled={loading}
              onChange={e => saveDraft(e.target.value)}
            />
            {draftUnavailable && <p id="draft-status" role="status" className="mb-3 text-sm text-amber-800">Draft storage is unavailable. Copy your request before leaving or refreshing this page.</p>}
            <button
              onClick={() => { void start(nl, undefined).then(sid => {
                if (sid) {
                  // Only clear the acknowledged request; never discard a newer draft.
                  try { if (sessionStorage.getItem(DRAFT_KEY) === nl) sessionStorage.removeItem(DRAFT_KEY); } catch { /* Keep the receipt usable even when storage is unavailable. */ }
                  navigate(`/translate/${sid}`, { replace: true });
                }
              }); }}
              disabled={loading || !nl.trim()}
              className="px-4 py-2 bg-teal-700 text-white text-sm rounded hover:bg-teal-800 disabled:opacity-50"
            >
              {loading ? 'Starting…' : 'Generate workflow'}
            </button>
            {loading && <GenerationWaiting restoring={Boolean(urlSid)} />}
            {error && <div className="mt-2 text-sm text-red-700">{error}</div>}
          </div><aside>{!urlSid && <GenerationHistory />}</aside></div>
        </div>
      </div>
    );
  }

  // ── Step 2: Review Changes ──────────────────────────────────────────────────

  if (phase === 'cc_running' || phase === 'cc_waiting_for_answer' || phase === 'confirm_merge') {
    return (
      <div className="flex flex-col h-full text-gray-900">
        <StepIndicator current={2} />
        <OriginalRequest text={originalRequest} history={history} />
        {step.revisionRequests?.length ? <details className="px-4 py-2 text-sm border-b border-line"><summary>Requested changes ({step.revisionRequests.length})</summary><ol className="mt-2 space-y-2">{step.revisionRequests.map((item,index)=><li key={item.reviewId} className="whitespace-pre-wrap break-words">{index+1}. {item.message}</li>)}</ol></details> : null}
        {(step.aiOutput || ['cc_running','cc_waiting_for_answer','auto_fixing'].includes(step.phase)) && <AiOutput text={step.aiOutput ?? ''} live={['cc_running','auto_fixing'].includes(step.phase)} />}
        {phase !== 'confirm_merge' && <div className="px-4 py-2 flex justify-end">
          <button disabled={loading} onClick={() => { void stop(); }} className="rounded border border-red-200 px-3 py-1.5 text-sm text-red-700 disabled:opacity-50">Stop generation</button>
        </div>}
        <div className="flex flex-1 overflow-hidden">
          {phase === 'confirm_merge' ? (
            <ConfirmMergeView
              key={step.phase==='confirm_merge'?step.reviewId:undefined}
              sessionId={sessionId ?? urlSid}
              step={step as Extract<SessionStep, { phase: 'confirm_merge' }>}
              respond={respond}
              loading={loading}
            />
          ) : (
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">

              {/* Waiting overlay — shown while CC thinks after an answer */}
              {waitingForCC && <WaitingView step={step} answering={loading && phase === 'cc_waiting_for_answer'} />}

              {/* Q&A question form — hidden while waiting */}
              {!waitingForCC && phase === 'cc_waiting_for_answer' && (() => {
                const q = step as Extract<typeof step, { phase: 'cc_waiting_for_answer' }>;
                const hasOptions = (q.options?.length ?? 0) > 0;
                const canSubmit = mcpSelectedOptionValue !== null || mcpFreeText.trim().length > 0;
                const buildAnswer = () => {
                  if (mcpSelectedOptionValue !== null && mcpFreeText.trim()) return `${mcpSelectedOptionValue}: ${mcpFreeText}`;
                  if (mcpSelectedOptionValue !== null) return mcpSelectedOptionValue;
                  return mcpFreeText;
                };
                const submitAnswer = () => {
                  if (!canSubmit || loading) return;
                  void respond({ type: 'mcp_answer', questionId: q.questionId, answer: buildAnswer() }).then(accepted => {
                    if (accepted) answerDraft.clear();
                  });
                };
                return (
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-0.5 bg-purple-50/40 border border-purple-300 rounded text-purple-700">
                        ❓ AI is asking
                      </span>
                    </div>
                    {q.aiHealth && <AiHealthSummary health={q.aiHealth} dark />}
                    <div className="text-sm text-gray-900 leading-relaxed">{q.question}</div>
                    <QuestionAnswerInput key={JSON.stringify([urlSid ?? sessionId, q.questionId])} options={q.options}
                      selected={mcpSelectedOptionValue} onSelect={value => answerDraft.setAnswer({ selectedOption: value, text: '' })}
                      text={mcpFreeText} onText={setMcpFreeText} disabled={loading} onSubmit={submitAnswer} />
                    {hasOptions && mcpSelectedOptionValue !== null && <details key={q.questionId} open={mcpFreeText.length > 0 || undefined}>
                      <summary className="cursor-pointer text-xs text-gray-600">Add context (optional)</summary>
                      <textarea aria-label="Additional context" rows={3} value={mcpFreeText} disabled={loading}
                        onChange={event => setMcpFreeText(event.target.value)} className="mt-2 w-full bg-gray-50 border border-gray-200 rounded p-2 text-sm text-gray-900" />
                    </details>}
                    <p role="status" className="text-xs text-gray-600">{answerDraft.unavailable
                      ? 'Answer draft storage is unavailable. Copy your answer before leaving or refreshing this page.'
                      : 'Your unsent answer is kept in this browser tab for this question until the server accepts it.'}</p>
                    <button
                      disabled={!canSubmit || loading}
                      onClick={submitAnswer}
                      className="self-start px-4 py-2 bg-teal-700 text-white text-sm rounded hover:bg-teal-800 disabled:opacity-50"
                    >
                      Send Answer →
                    </button>
                  </div>
                );
              })()}

              {/* cc_running with no waitingForCC = initial generation (rare path) */}
              {!waitingForCC && phase === 'cc_running' && (
                <div className="flex items-center gap-3 text-gray-600 text-sm mt-8 justify-center">
                  <span className="animate-spin inline-block text-lg">⟳</span>
                  Generating…
                </div>
              )}

            </div>
          )}
        </div>
        {error && <div role="alert" className="p-4 text-sm text-red-700">
          <p>{error}</p>
          {sessionId && <button disabled={loading} className="mt-2 rounded border border-gray-200 px-3 py-1 text-gray-900 disabled:opacity-50"
            onClick={() => { void resumeSession(sessionId).catch(() => {}); }}>Refresh task status</button>}
        </div>}
      </div>
    );
  }

  // ── Done ────────────────────────────────────────────────────────────────────

  if (step.phase === 'done') {
    const published=publishedWorkflows(step);
    const paths: string[] = step.savedPaths && step.savedPaths.length > 0
      ? step.savedPaths
      : step.savedPath ? [step.savedPath] : [];
    return (
      <div className="flex flex-col h-full text-gray-900">
        <StepIndicator current={STEPS.length + 1} />
        <OriginalRequest text={originalRequest} history={history} />
        {(step.aiOutput || ['cc_running','cc_waiting_for_answer','auto_fixing'].includes(step.phase)) && <AiOutput text={step.aiOutput ?? ''} live={['cc_running','auto_fixing'].includes(step.phase)} />}
        <div className="flex-1 p-6">
          {paths.length > 0 ? (
            <>
              <div className="text-green-700 font-medium mb-2">✓ Changes published</div>
              {published.length>0 ? <div className="max-w-2xl space-y-3 mt-4">{published.map(name=><div key={name} className="surface p-4 flex flex-wrap items-center justify-between gap-3"><Link to={`/intents?${new URLSearchParams({intent:name})}`} className="subtle-link break-all">{name}</Link><button className="primary-action" onClick={()=>setRunEntry(name)}>Run {name}</button></div>)}</div> : <Link to="/intents" className="subtle-link inline-block mt-3">Open workflow library</Link>}
              <details className="mt-4 text-xs text-muted"><summary>Published files</summary><ul className="space-y-1 mt-2">{paths.map(p => <li key={p} className="font-mono break-all">{p}</li>)}</ul></details>
            </>
          ) : (
            <div className="text-gray-600 text-sm">No changes were published.</div>
          )}
          <button onClick={() => navigate('/translate')} className="mt-4 px-3 py-1.5 text-sm rounded bg-gray-50 text-gray-600 hover:bg-gray-600">
            Create another workflow
          </button>
          <RunTriggerDialog open={Boolean(runEntry)} onOpenChange={open=>{if(!open)setRunEntry(undefined);}} prefillIntent={runEntry} />
        </div>
      </div>
    );
  }

  // ── Auto-fixing ──────────────────────────────────────────────────────────────

  if (phase === 'auto_fixing') {
    const fixStep = step as Extract<SessionStep, { phase: 'auto_fixing' }>;
    return (
      <div className="flex flex-col h-full text-gray-900">
        <StepIndicator current={currentVisualStep} />
        <OriginalRequest text={originalRequest} history={history} />
        {(step.aiOutput || ['cc_running','cc_waiting_for_answer','auto_fixing'].includes(step.phase)) && <AiOutput text={step.aiOutput ?? ''} live={['cc_running','auto_fixing'].includes(step.phase)} />}
        <div className="px-4 py-2 flex justify-end"><button disabled={loading} onClick={() => { void stop(); }} className="rounded border border-red-200 px-3 py-1.5 text-sm text-red-700 disabled:opacity-50">Stop generation</button></div>
        <div className="flex-1 p-6">
          <div className="max-w-lg">
            <div className="text-red-700 text-sm mb-3 font-mono whitespace-pre-wrap">{fixStep.lastError}</div>
            <div className="flex items-center gap-2 text-sm text-yellow-700">
              <span className="animate-spin inline-block w-4 h-4 border-2 border-yellow-400 border-t-transparent rounded-full" />
              AI is fixing compilation errors (attempt {fixStep.fixAttempt}/3)…
            </div>
            {fixStep.aiHealth ? <div className="mt-3"><AiHealthSummary health={fixStep.aiHealth} dark /></div> : <GenerationWaiting />}
            {error && <div role="alert" className="mt-3 text-sm text-red-700">{error}</div>}
          </div>
        </div>
      </div>
    );
  }

  // ── Error ───────────────────────────────────────────────────────────────────

  if (step.phase === 'error') {
    const capacityBlocked = step.blockingSessionIds !== undefined || step.message.includes('No translator slot available');
    return (
      <div className="flex flex-col h-full text-gray-900">
        <StepIndicator current={currentVisualStep} />
        <OriginalRequest text={originalRequest} history={history} />
        {(step.aiOutput || ['cc_running','cc_waiting_for_answer','auto_fixing'].includes(step.phase)) && <AiOutput text={step.aiOutput ?? ''} live={['cc_running','auto_fixing'].includes(step.phase)} />}
        <div className="flex-1 p-6">
          <div className="max-w-lg">
            {capacityBlocked ? <div className="text-sm mb-4">
              <h2 className="font-semibold text-amber-700">This request did not start</h2>
              <p className="mt-2 text-gray-600">All generation workspaces were occupied when you submitted this request. This is a saved failure, not a live capacity check. It will not restart automatically after a workspace is released.</p>
              <p className="mt-2 text-gray-600">If you have already ended the tasks below, you can submit your request again. Their links record the tasks occupying workspaces at the time of this failure; they do not mean those tasks still block you.</p>
              {(step.blockingSessionIds?.length ?? 0) > 0 ? <ul className="my-3 space-y-2">
                {step.blockingSessionIds!.map(id => <li key={id}><a className="text-teal-800 underline break-all" href={`/translate/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">Open task {id}</a></li>)}
              </ul> : <p className="mt-2 text-gray-600">No task links were recorded for this failure. If a new submission is also blocked, check generation history; retained workspaces may require operator recovery.</p>}
              <p className="mt-2 text-gray-600">If a linked task is still awaiting review, approving or rejecting its result releases its workspace. The button below copies your original request into a new draft; click Start there to submit it. Availability is checked on submission.</p>
              <button className="mt-3 rounded bg-teal-700 px-3 py-1.5 text-white" onClick={() => { const request = originalRequest; navigate('/translate', { state: { naturalLanguage: request } }); }}>Copy request to new draft</button>
            </div> : <div className="text-red-700 text-sm mb-3">{String(step.message ?? 'An error occurred')}</div>}
            {error && <div role="alert" className="text-red-700 text-sm mb-3">Could not continue this task: {error}</div>}
            {!!step.retryable && (
              <button disabled={loading} onClick={() => respond({ type: 'retry' })} className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">{loading ? 'Retrying…' : 'Retry'}</button>
            )}
            {!capacityBlocked && !step.retryable && originalRequest && <div className="mt-4 text-sm text-gray-600">
              <p>This task will not restart automatically. Review any completed actions before starting a new task. You can copy the original request into a new draft.</p>
              <button className="mt-3 rounded bg-teal-700 px-3 py-1.5 text-white" onClick={() => navigate('/translate', { state: { naturalLanguage: originalRequest } })}>Copy request to new draft</button>
            </div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full text-gray-900">
      <StepIndicator current={currentVisualStep} />
      <div className="flex-1 p-6 text-sm text-gray-600">Phase: {phase}</div>
    </div>
  );
}
