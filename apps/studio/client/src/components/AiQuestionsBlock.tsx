import { QuestionAnswerInput } from './QuestionAnswerInput';
import { useEffect, useState } from 'react';
import { answerAiQuestion, getAiQuestions, type AiQuestionItem } from '../api/ai-questions';

function QuestionCard({ item, runId, refresh, active }: { item: AiQuestionItem; runId: string; refresh(): Promise<void>; active: boolean }) {
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const canSubmit = selected !== null || (item.question.optionsMode !== 'exclusive' && !!value.trim());
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const pending = active && item.status === 'pending' && item.available;
  async function submit() {
    if (!canSubmit || sending || uncertain) return;
    let answer: unknown = selected ?? value;
    setError('');
    if (selected === null && item.question.answer === 'json') {
      try { answer = JSON.parse(value); }
      catch { setError('Enter valid JSON.'); return; }
    }
    setSending(true);
    try {
      const receipt = await answerAiQuestion(runId, { taskId: item.taskId, attemptId: item.attemptId, questionId: item.questionId }, answer);
      if (receipt !== 'accepted' && receipt !== 'duplicate') {
        setError(receipt === 'invalid_answer' ? 'The answer does not match this question.' : `Answer was not confirmed: ${receipt}`);
        if (receipt === 'outcome_unknown' || receipt === 'in_progress') setUncertain(true);
      }
    } catch {
      setUncertain(true);
      setError('Delivery could not be confirmed. Reload to inspect the saved status before submitting again.');
    } finally { setSending(false); await refresh(); }
  }
  return <section aria-label={item.question.prompt} className="border border-orange-200 rounded p-3 space-y-2 bg-orange-50">
    <div className="flex gap-2 text-xs text-gray-500"><span>{item.instruction}</span><span className="ml-auto">{item.status}</span></div>
    <p className="text-sm text-gray-900 whitespace-pre-wrap">{item.question.prompt}</p>
    {item.status === 'answered' && <pre className="text-xs whitespace-pre-wrap break-words">{item.question.options?.find(option => option.value === item.answer)?.label ?? (typeof item.answer === 'string' ? item.answer : JSON.stringify(item.answer, null, 2) ?? 'Answer accepted')}</pre>}
    {item.reason && <p className="text-xs text-gray-600">{item.reason}</p>}
    {pending && <>
      <QuestionAnswerInput options={item.question.options} exclusive={item.question.optionsMode === 'exclusive'} selected={selected}
        onSelect={setSelected} text={value} onText={setValue} disabled={sending || uncertain} json={item.question.answer === 'json'} />
      <button disabled={!canSubmit || sending || uncertain} onClick={() => { void submit(); }} className="rounded bg-orange-600 text-white text-sm px-3 py-1.5 disabled:opacity-40">{sending ? 'Sending…' : 'Send answer'}</button>
    </>}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </section>;
}

export function AiQuestionsBlock({ runId, runStatus }: { runId: string; runStatus: string }) {
  const [items, setItems] = useState<AiQuestionItem[]>([]);
  const [error, setError] = useState('');
  // Mount with key=runId so drafts and delayed requests cannot cross runs.
  const [loading, setLoading] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const [reload, setReload] = useState(0);
  async function refresh() {
    setReload(value => value + 1);
  }
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      setLoading(true);
      try { const data = await getAiQuestions(runId, controller.signal); if (!stopped) { setItems(data); setError(''); } }
      catch (e) { if (!stopped) setError(`Could not load AI questions. ${e instanceof Error ? e.message : String(e)}`); }
      finally { if (!stopped) { setLoading(false); setAttempted(true); } }
      if (!stopped && runStatus === 'running') timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [runId, runStatus, reload]);
  if (!items.length && !error && attempted) return null;
  return <div className="px-4 py-3 border-b border-gray-200 max-h-96 overflow-auto shrink-0">
    <h2 className="text-sm font-semibold text-orange-700 mb-2">AI Questions</h2>
    {loading && !items.length && (!attempted || error) && <p role="status" className="text-xs text-gray-600">Loading AI questions…</p>}
    {error && <p role="alert" className="text-xs text-red-700">{error} <button disabled={loading} className="underline disabled:opacity-40" onClick={() => { void refresh(); }}>Retry questions</button></p>}
    <div className="space-y-2">{items.map(item => <QuestionCard key={JSON.stringify([item.taskId, item.attemptId, item.questionId])} item={item} runId={runId} refresh={refresh} active={runStatus === 'running' && !error} />)}</div>
  </div>;
}
