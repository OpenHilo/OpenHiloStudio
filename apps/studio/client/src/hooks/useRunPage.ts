import { useSearchParams } from 'react-router-dom';

export function useRunPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('page') ?? '1';
  const parsed = /^\d+$/.test(raw) ? Number(raw) : 1;
  const page = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  const setPage = (next: number) => setParams(previous => {
    const query = new URLSearchParams(previous);
    if (next <= 1) query.delete('page');
    else query.set('page', String(next));
    return query;
  }, { replace: true });
  return { page, setPage };
}
