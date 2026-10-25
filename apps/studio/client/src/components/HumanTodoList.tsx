// platform/client/src/components/HumanTodoList.tsx
import { useNavigate } from 'react-router-dom';
import { useHumanTodos } from '../hooks/useHumanTodos';

export function HumanTodoList() {
  const { todos, loading, error, refresh } = useHumanTodos();
  const nav = useNavigate();

  if (error) return <div role="alert" className="text-sm text-red-600">Unable to load pending human tasks. Check the server connection and retry. <button className="underline" onClick={refresh}>Retry human tasks</button></div>;
  if (loading) return <div role="status" className="text-sm text-gray-600">Loading pending human tasks…</div>;
  if (!todos.length) return <div className="text-sm text-gray-600">No pending human tasks.</div>;

  return (
    <div className="space-y-2">
      {todos.map(t => (
        <button
          key={t.runId}
          onClick={() => nav(`/runs/${t.runId}/human`)}
          className="block w-full text-left border border-orange-200 bg-orange-50 rounded p-3 cursor-pointer hover:bg-orange-100"
        >
          <div className="font-medium text-sm text-gray-900">{t.intent}</div>
          <div className="text-xs text-gray-500 truncate">{t.prompt}</div>
          {t.acceptedSubmission && <div className="text-xs text-teal-800">Decision saved · Check continuation</div>}
          <div className="text-xs text-gray-600 mt-1">{new Date(t.suspendedAt).toLocaleString()}</div>
        </button>
      ))}
    </div>
  );
}
