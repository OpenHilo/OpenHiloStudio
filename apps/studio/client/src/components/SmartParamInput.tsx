// platform/client/src/components/SmartParamInput.tsx
import { useState } from 'react';

export type ValueType = 'text' | 'number' | 'boolean' | 'json' | 'file' | 'dir';

interface Props {
  type: ValueType;
  value: unknown;
  onChange: (value: unknown) => void;
  label?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  onValidityChange?: (message: string | null) => void;
}

const inputClass =
  'w-full bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 disabled:opacity-50';

const errorClass = 'mt-1 text-xs text-red-700';

interface SubProps {
  value: unknown;
  onChange: (value: unknown) => void;
  label?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  onValidityChange?: (message: string | null) => void;
}

function NumberInput({ value, onChange, label, error, disabled, required, onValidityChange }: SubProps) {
  const [raw, setRaw] = useState(value != null ? String(value) : '');
  const numError = raw !== '' && (!Number.isFinite(Number(raw)) || Object.is(Number(raw), -0)) ? 'Must be a finite number other than negative zero' : null;
  return (
    <div>
      {label && <div className="text-xs text-gray-600 mb-1">{label}{required && <span> (required)</span>}</div>}
      <input
        type="number"
        aria-label={label}
        aria-required={required}
        aria-invalid={Boolean(error)}
        className={`${inputClass} ${numError ? 'border-red-300' : ''}`}
        value={raw}
        disabled={disabled}
        onChange={e => {
          setRaw(e.target.value);
          const text = e.target.value, number = Number(text);
          const invalid = text !== '' && (!Number.isFinite(number) || Object.is(number, -0));
          onValidityChange?.(invalid ? 'Must be a finite number other than negative zero' : null);
          if (!invalid) onChange(text === '' ? '' : number);
        }}
      />
      {numError && <div className={errorClass}>{numError}</div>}
      {error && error !== numError && <div className={errorClass}>{error}</div>}
    </div>
  );
}

function JsonInput({ value, onChange, label, error, disabled, required, onValidityChange }: SubProps) {
  const strVal = value === undefined ? '' : JSON.stringify(value, null, 2);
  const [raw, setRaw] = useState(strVal);
  const [jsonError, setJsonError] = useState<string | null>(null);

  function update(text: string) {
    setRaw(text);
    try {
      const parsed = JSON.parse(text, (_key, item: unknown) => {
        if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) throw new Error('Invalid JSON number');
        return item;
      });
      setJsonError(null); onValidityChange?.(null); onChange(parsed);
    } catch { setJsonError('Invalid JSON'); onValidityChange?.('Invalid JSON'); }
  }

  return (
    <div>
      {label && (
        <div className="text-xs text-gray-600 mb-1">
          {label}{required && <span> (required)</span>} <span className="text-gray-600">json</span>
        </div>
      )}
      <textarea
        rows={4}
        aria-label={label}
        aria-required={required}
        aria-invalid={Boolean(error)}
        className={`${inputClass} font-mono text-xs ${jsonError ? 'border-red-300' : ''}`}
        value={raw}
        disabled={disabled}
        onChange={e => update(e.target.value)}
      />
      {jsonError && <div className={errorClass}>{jsonError}</div>}
      {error && error !== jsonError && <div className={errorClass}>{error}</div>}
    </div>
  );
}

export function SmartParamInput({ type, value, onChange, label, error, disabled, required, onValidityChange }: Props) {
  if (type === 'boolean') {
    const boolVal = value === true || value === 'true';
    return (
      <div>
        {label && <div className="text-xs text-gray-600 mb-1">{label}{required && <span> (required)</span>}</div>}
        <div className="inline-flex rounded overflow-hidden border border-gray-200">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(true)}
            aria-pressed={boolVal}
            className={`px-4 py-1.5 text-sm ${boolVal ? 'bg-teal-700 text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
          >
            true
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(false)}
            aria-pressed={!boolVal}
            className={`px-4 py-1.5 text-sm border-l border-gray-200 ${!boolVal ? 'bg-teal-700 text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
          >
            false
          </button>
        </div>
      </div>
    );
  }

  if (type === 'number') {
    return <NumberInput value={value} onChange={onChange} label={label} error={error} disabled={disabled} required={required} onValidityChange={onValidityChange} />;
  }

  if (type === 'json') {
    return <JsonInput value={value} onChange={onChange} label={label} error={error} disabled={disabled} required={required} onValidityChange={onValidityChange} />;
  }

  // text, file, dir
  const placeholder = type === 'file' ? '/path/to/file' : type === 'dir' ? '/path/to/dir' : '';
  return (
    <div>
      {label && <div className="text-xs text-gray-600 mb-1">{label}{required && <span> (required)</span>}</div>}
      <input
        type="text"
        aria-label={label}
        aria-required={required}
        aria-invalid={Boolean(error)}
        className={inputClass}
        value={value != null ? String(value) : ''}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      />
      {error && <div className={errorClass}>{error}</div>}
    </div>
  );
}
