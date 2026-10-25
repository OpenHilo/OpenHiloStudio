// ── HumanOutputField ──────────────────────────────────────────────────────────

interface FieldProps {
  name: string;
  kind: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}

export function HumanOutputField({ name, kind, value, onChange, error }: FieldProps) {
  const baseInput = 'w-full border rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-orange-400';
  const errBorder = error ? 'border-red-400' : 'border-gray-300';

  if (kind === 'boolean') {
    return (
      <div className="flex gap-3">
        {([['true', 'True'], ['false', 'False']] as const).map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={`flex-1 py-2 rounded border text-sm font-medium transition-colors ${
              value === v
                ? 'bg-teal-700 border-teal-700 text-white'
                : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    );
  }

  if (kind === 'number') {
    return (
      <>
        <input
          aria-label={name}
          type="number"
          className={`${baseInput} ${errBorder}`}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Enter a number…"
        />
        {error && <div className="text-xs text-red-500 mt-1">{error}</div>}
      </>
    );
  }

  if (kind === 'json') {
    return (
      <>
        <textarea
          aria-label={name}
          className={`${baseInput} ${errBorder} font-mono`}
          rows={5}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={'["item1", "item2"]  or  {"key": "value"}'}
        />
        {error && <div className="text-xs text-red-500 mt-1">{error}</div>}
      </>
    );
  }

  if (kind === 'file' || kind === 'dir') {
    return (
      <>
        <input
          aria-label={name}
          type="text"
          className={`${baseInput} ${errBorder} font-mono`}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={kind === 'file' ? '/absolute/path/to/file' : '/absolute/path/to/dir'}
        />
        <div className="text-xs text-gray-600 mt-1">Enter absolute path</div>
      </>
    );
  }

  // default: text
  return (
    <textarea
          aria-label={name}
      className={`${baseInput} ${errBorder}`}
      rows={3}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="Enter value…"
    />
  );
}

// ── Resolved input value renderer ─────────────────────────────────────────────

export function ResolvedInputValue({ raw }: { raw: string }) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      return (
        <pre className="text-xs text-gray-700 font-mono whitespace-pre-wrap mt-0.5">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    }
  } catch {}
  return <div className="text-sm text-gray-800 whitespace-pre-wrap break-words">{raw === '' ? '"" (empty text)' : raw}</div>;
}
