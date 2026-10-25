// platform/client/src/hooks/useRunEvents.ts
import { useState, useEffect } from 'react';

export interface RunEvent { type: 'event' | 'done' | 'error'; [key: string]: unknown; }

export function useRunEvents(runId: string) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setEvents([]);
    setDone(false);
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.onmessage = (e) => {
      const parsed: RunEvent = JSON.parse(e.data);
      setEvents(prev => [...prev, parsed]);
      if (parsed.type === 'done' || parsed.type === 'error') {
        setDone(true);
        es.close();
      }
    };
    es.onerror = () => { setDone(true); es.close(); };
    return () => es.close();
  }, [runId]);

  return { events, done };
}
