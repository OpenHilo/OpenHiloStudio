// platform/client/src/pages/DashboardPage.tsx
import { Link } from 'react-router-dom';
import { StatsBar } from '../components/StatsBar';
import { HumanTodoList } from '../components/HumanTodoList';

export function DashboardPage() {
  return (
    <div>
      <header className="page-heading"><div><h1>Overview</h1></div><Link className="primary-action" to="/translate">Create workflow</Link></header>
      <StatsBar />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mt-2">
        <div>
          <h2 className="text-base font-semibold mb-2 text-gray-700">Waiting for you</h2>
          <HumanTodoList />
        </div>
        <div>
          <h2 className="text-base font-semibold mb-2 text-gray-700">Continue your work</h2>
          <div className="space-y-2">
            {[
              { label: 'Review runs and results', path: '/history' },
              { label: 'Respond to human tasks', path: '/human' },
              { label: 'Describe a new workflow', path: '/translate' },
              { label: 'Manage schedules', path: '/schedules' },
            ].map(l => (
              <Link key={l.path} to={l.path} className="block w-full text-left px-3 py-2 rounded border border-gray-200 text-sm text-gray-700 hover:bg-gray-50">
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
