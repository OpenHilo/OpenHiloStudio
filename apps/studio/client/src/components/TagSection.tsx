import type { TagDefinition } from '../api/entities';

import { allowedTagValues, changeTagValue, effectiveTagValues } from '../lib/tag-values';

interface TagSectionProps {
  tagDefs: TagDefinition[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

export function TagSection({ tagDefs, values, onChange }: TagSectionProps) {
  const effective = effectiveTagValues(tagDefs, values);
  function set(name: string, value: string) {
    onChange(changeTagValue(tagDefs, values, name, value));
  }

  const sorted = [...tagDefs].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {sorted.map(def => {
        const isDisabled = !!def.parentTag && !effective[def.parentTag];
        const allowedValues = allowedTagValues(def, effective);
        const currentVal = effective[def.name] ?? '';
        const invalid = def.required && !currentVal;

        return (
          <div key={def.name}>
            <div className="text-xs text-gray-600 mb-1">
              {def.name}
              {def.required && <span className="text-red-700 ml-0.5">*</span>}
            </div>
            <select
              aria-label={def.name}
              className={`w-full bg-gray-50 border rounded px-2 py-1.5 text-xs text-gray-900 disabled:opacity-40 ${invalid ? 'border-red-300' : 'border-gray-200'}`}
              value={currentVal}
              onChange={e => set(def.name, e.target.value)}
              disabled={isDisabled}
            >
              {def.required && <option value="" disabled>— 请选择 —</option>}
              {!def.required && <option value="">— optional —</option>}
              {allowedValues.map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
