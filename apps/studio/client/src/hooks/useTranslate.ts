import { useState, useRef, useEffect } from 'react';
import { stopTranslate, startTranslate, acknowledgeTranslateStart, respondTranslate, pollTranslate, type SessionStep, type SessionInput } from '../api/translate';

export interface QAEntry { question: string; answer: string }
const automatic = (step: SessionStep | null) => step?.phase === 'cc_running' || step?.phase === 'auto_fixing';
export const needsPolling = (step: SessionStep | null) => automatic(step) || step?.phase === 'cc_waiting_for_answer';

export function useTranslate() {
  const [step, setStep] = useState<SessionStep | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<QAEntry[]>([]);
  const [originalRequest, setOriginalRequest] = useState('');
  const sidRef = useRef<string | null>(null);
  const epoch = useRef(0);
  const pendingQuestion = useRef('');
  const sessionRead = useRef(new AbortController());
  const sessionId = sidRef.current;
  const auto = automatic(step);
  const pollActive = needsPolling(step);

  function accept(next: SessionStep, fromPoll = false) {
    if (next.naturalLanguage !== undefined) setOriginalRequest(next.naturalLanguage);
    if (next.answerHistory) setHistory(next.answerHistory);
    else if (next.answers) setHistory(Object.entries(next.answers).map(([question, answer]) => ({ question, answer })));
    if (next.phase === 'cc_waiting_for_answer') pendingQuestion.current = next.question;
    setStep(next);
    setError(previous => fromPoll && !previous?.startsWith('Unable to refresh generation:') ? previous : null);
  }

  useEffect(() => () => { epoch.current++; sessionRead.current.abort(); }, []);
  useEffect(() => {
    if (!pollActive || !sessionId) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const current = epoch.current;
    // Schedule after each response: slow GETs cannot overlap and arrive out of order.
    async function poll() {
      let again = true;
      try {
        const next = await pollTranslate(sessionId!, controller.signal);
        if (cancelled || current !== epoch.current) return;
        accept(next, true);
        again = needsPolling(next);
      } catch (error) {
        if (cancelled || current !== epoch.current) return;
        setError(`Unable to refresh generation: ${String(error)}`);
      }
      if (again && !cancelled) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 2000);
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [pollActive, sessionId]);

  function reset() {
    epoch.current++;
    sessionRead.current.abort(); sessionRead.current = new AbortController();
    sidRef.current = null;
    pendingQuestion.current = '';
    setStep(null); setLoading(false); setError(null); setHistory([]); setOriginalRequest('');
  }

  async function start(naturalLanguage: string, workspace?: string) {
    reset();
    setOriginalRequest(naturalLanguage);
    const current = epoch.current;
    setLoading(true);
    try {
      const result = await startTranslate(naturalLanguage, workspace);
      if (current !== epoch.current) return;
      acknowledgeTranslateStart(result.sessionId);
      sidRef.current = result.sessionId;
      accept(result.step);
      return result.sessionId;
    } catch (error) { if (current === epoch.current) setError(String(error)); }
    finally { if (current === epoch.current) setLoading(false); }
  }

  async function respond(input: SessionInput): Promise<boolean> {
    if (!sidRef.current) return false;
    const current = epoch.current, question = pendingQuestion.current;
    setLoading(true); setError(null);
    try {
      const next = await respondTranslate(sidRef.current, input);
      if (current !== epoch.current) return false;
      // A rejected answer remains editable and is not recorded as accepted history.
      if (input.type === 'mcp_answer' && next.phase !== 'error' && !next.answers && !next.answerHistory) setHistory(previous => [...previous, { question, answer: input.answer }]);
      accept(next);
      if (input.type === 'merge_approve' && next.phase === 'confirm_merge') {
        setError('The candidate changed since your review. Nothing was published. Review the updated changes before approving again.');
        return false;
      }
      return input.type !== 'mcp_answer' || next.phase !== 'error';
    } catch (error) { if (current === epoch.current) setError(String(error)); return false; }
    finally { if (current === epoch.current) setLoading(false); }
  }

  async function stop() {
    if (!sidRef.current) return;
    const current = epoch.current;
    setLoading(true); setError(null);
    try {
      const next = await stopTranslate(sidRef.current);
      if (current === epoch.current) accept(next);
    } catch (error) { if (current === epoch.current) setError(String(error)); }
    finally { if (current === epoch.current) setLoading(false); }
  }

  async function resumeSession(sid: string) {
    reset();
    const current = epoch.current;
    setLoading(true);
    try {
      const next = await pollTranslate(sid, sessionRead.current.signal);
      if (current !== epoch.current) return;
      sidRef.current = sid;
      accept(next);
    } catch (error) {
      if (current !== epoch.current) return;
      setError(String(error));
      throw error;
    } finally { if (current === epoch.current) setLoading(false); }
  }

  return { step, loading, error, history, originalRequest, waitingForCC: loading || auto,
    start, respond, stop, resumeSession, reset, sessionId };
}
