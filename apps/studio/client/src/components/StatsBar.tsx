// platform/client/src/components/StatsBar.tsx
import {Link} from 'react-router-dom';
import { useStats } from '../hooks/useStats';

export function StatsBar() {
  const { stats, error, loading, refresh } = useStats();
  if (error) return <div role="alert" className="mb-4 text-sm text-red-600">{error} <button className="underline" onClick={refresh}>Retry statistics</button></div>;
  if (loading || !stats) return <div role="status" className="h-16 text-sm text-gray-500">Loading dashboard statistics…</div>;

  const cards = [
    { label: 'All runs', value: stats.totalRuns, href:'/history' },
    { label: 'Running', value: stats.runningRuns, href:'/history?status=running', color: 'text-teal-700' },
    { label: 'Completed today', value: stats.completedToday, href:`/history?status=completed&completedOn=${new Date().toISOString().slice(0,10)}`, color: 'text-green-600' },
    { label: 'Failed', value: stats.failedRuns, href:'/history?status=failed', color: stats.failedRuns > 0 ? 'text-red-600' : '' },
    { label: 'Waiting for you', value: stats.pendingHumanNodes, href:'/human', color: stats.pendingHumanNodes > 0 ? 'text-orange-600' : '' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 border-y border-line mb-8">
      {cards.map(c => (
        <div key={c.label} className="py-5 px-4">{c.href ? <Link to={c.href} className="block hover:underline underline-offset-4"><div className={`text-3xl font-semibold ${c.color ?? 'text-ink'}`}>{c.value}</div><div className="text-sm text-muted mt-1">{c.label}</div></Link> : <>
          <div className={`text-2xl font-bold ${c.color ?? 'text-gray-900'}`}>{c.value}</div>
          <div className="text-sm text-muted mt-1">{c.label}</div></>}
        </div>
      ))}
    </div>
  );
}
