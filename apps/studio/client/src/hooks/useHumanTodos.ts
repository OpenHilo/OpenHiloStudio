import { useState, useEffect } from 'react';
import { getHumanTodos, type HumanTodo } from '../api/human';

export function useHumanTodos(intervalMs = 3000) {
  const [todos, setTodos] = useState<HumanTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true, busy = false;
    const controller = new AbortController();
    setLoading(true); setError(null);
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const result = await getHumanTodos(controller.signal);
        if (active) { setTodos(result); setError(null); }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Unable to load pending human tasks.');
      } finally { busy = false; if (active) setLoading(false); }
    }
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => { active = false; clearInterval(timer); controller.abort(); };
  }, [intervalMs, revision]);
  return { todos, loading, error, refresh: () => setRevision(value => value + 1) };
}
