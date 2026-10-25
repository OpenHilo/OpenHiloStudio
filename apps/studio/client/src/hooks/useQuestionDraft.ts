import { useState } from 'react';

type Draft = { text: string; selectedOption: string | null; unavailable: boolean };
const empty = (): Draft => ({ text: '', selectedOption: null, unavailable: false });

function read(key: string): Draft {
  if (!key) return empty();
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return empty();
    const data = JSON.parse(raw);
    if (!data || typeof data.text !== 'string' || (data.selectedOption !== null && typeof data.selectedOption !== 'string')) return empty();
    return { text: data.text, selectedOption: data.selectedOption, unavailable: false };
  } catch { return { ...empty(), unavailable: true }; }
}

/** Scope unsent answers to both identities; never display another question's draft. */
export function useQuestionDraft(sessionId?: string | null, questionId?: string) {
  const key = sessionId && questionId ? `intentorch.answer.${JSON.stringify([sessionId, questionId])}` : '';
  const [state, setState] = useState(() => ({ key, ...read(key) }));
  const draft = state.key === key ? state : read(key);
  function update(patch: Partial<Pick<Draft, 'text' | 'selectedOption'>>) {
    const next = { key, ...draft, ...patch };
    try {
      if (key) sessionStorage.setItem(key, JSON.stringify({ text: next.text, selectedOption: next.selectedOption }));
      next.unavailable = false;
    } catch { next.unavailable = true; }
    setState(next);
  }
  function clear() {
    try { if (key) sessionStorage.removeItem(key); } catch { /* Current-page input can still be cleared. */ }
    // A late receipt for an old question must not erase the next question's input.
    setState(current => current.key === key ? { key, ...empty() } : current);
  }
  return { ...draft, setAnswer: update, setText: (text: string) => update({ text }),
    setSelectedOption: (selectedOption: string | null) => update({ selectedOption }), clear };
}
