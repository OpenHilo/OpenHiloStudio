import { useEffect, useId, useRef, useState } from 'react';
import { filterScheduleIntents } from '../lib/schedule-form';

type Workflow = { name: string; desc: string; ittPath: string };

export function WorkflowCombobox({ items, value, disabled, onChange, required = true, placeholder = 'Search or select a published workflow' }: {
  items: Workflow[]; value: string; disabled: boolean; required?: boolean; placeholder?: string; onChange(value: string): void;
}) {
  const id = useId(), input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const choice = items.find(item => item.ittPath === value);
  const filtered = filterScheduleIntents(items, query ?? '');
  const expanded = open && !disabled;
  const activeId = expanded && active >= 0 && active < filtered.length ? `${id}-option-${active}` : undefined;
  useEffect(() => { if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' }); }, [activeId]);

  function close() { setOpen(false); setQuery(null); setActive(-1); }
  function choose(item: Workflow) { onChange(item.ittPath); close(); }
  function show() { setOpen(true); setActive(-1); }

  return <div className="relative text-sm" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  }}>
    <label htmlFor={id} className="block mb-1">Workflow</label>
    <div className="flex rounded border border-gray-200 bg-gray-50 focus-within:ring-2 focus-within:ring-blue-400">
      <input ref={input} id={id} role="combobox" aria-autocomplete="list" aria-expanded={expanded}
        aria-controls={expanded ? `${id}-list` : undefined} aria-activedescendant={activeId}
        autoComplete="off" required={required} disabled={disabled} placeholder={placeholder}
        className="min-w-0 flex-1 rounded bg-transparent px-2 py-1.5 text-gray-900 outline-none disabled:opacity-50"
        value={query ?? choice?.name ?? ''}
        onFocus={event => { show(); event.currentTarget.select(); }}
        onClick={() => { if (!expanded) show(); }}
        onChange={event => {
          // Typed search text is not a selected workflow, even if its name matches.
          if (value) onChange('');
          setQuery(event.target.value); setOpen(true); setActive(-1);
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setOpen(true);
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            setActive(previous => !filtered.length ? -1 : !expanded || previous < 0
              ? (direction === 1 ? 0 : filtered.length - 1)
              : (previous + direction + filtered.length) % filtered.length);
          } else if (event.key === 'Enter' && expanded) {
            event.preventDefault();
            if (active >= 0 && filtered[active]) choose(filtered[active]);
            else if (filtered.length === 1) choose(filtered[0]);
          } else if (event.key === 'Escape' && expanded) {
            event.preventDefault(); event.stopPropagation(); close();
          } else if (event.key === 'Tab') close();
        }} />
      {choice && <button type="button" disabled={disabled} aria-label="Clear workflow" className="px-2 text-gray-600 disabled:opacity-50"
        onClick={() => { onChange(''); setQuery(''); setActive(-1); input.current?.focus(); setOpen(true); }}>×</button>}
      <button type="button" disabled={disabled} aria-label={expanded ? 'Hide workflows' : 'Show workflows'} aria-expanded={expanded}
        className="px-2 text-gray-600 disabled:opacity-50" onClick={() => {
          if (expanded) close(); else { input.current?.focus(); show(); }
        }}>▾</button>
    </div>
    {expanded && <div className="absolute z-20 mt-1 w-full overflow-hidden rounded border border-gray-200 bg-gray-50 shadow-lg">
      <ul id={`${id}-list`} role="listbox" aria-label="Published workflows" className="max-h-60 overflow-y-auto py-1">
        {filtered.map((item, index) => <li key={item.ittPath} id={`${id}-option-${index}`} role="option" aria-selected={item.ittPath === value}
          className={`cursor-pointer px-3 py-2 break-words ${index === active ? 'bg-teal-700 text-white' : 'text-gray-900 hover:bg-gray-100'}`}
          onPointerDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(item)}>
          <span className="flex justify-between gap-2"><span>{item.name}</span>{item.ittPath === value && <span aria-hidden="true">✓</span>}</span>
          {item.desc && <span className="block text-xs text-gray-600">{item.desc}</span>}
        </li>)}
      </ul>
      {!filtered.length && <p role="status" className="px-3 py-3 text-gray-600">{items.length ? 'No matching workflows. Try another name or description.' : 'No published workflows. Create and publish one first.'}</p>}
    </div>}
  </div>;
}
