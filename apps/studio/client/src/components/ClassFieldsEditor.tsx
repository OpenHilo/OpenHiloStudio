import { createClientId } from '../lib/client-id';
import { useRef, useState } from 'react';
import { classFieldsToSchema, classFieldTypes, parseClassSchema, schemaToClassFields, validateClassFields, type ClassField } from '../lib/class-fields';

export interface ClassFieldsDraft {
  fields: (ClassField & { id: string })[];
  advanced: boolean;
  raw: string;
}
export function emptyClassFieldsDraft(): ClassFieldsDraft { return { fields: [], advanced: false, raw: '{}' }; }
export function schemaFromClassDraft(draft: ClassFieldsDraft): Record<string, unknown> {
  return draft.advanced ? parseClassSchema(draft.raw) : classFieldsToSchema(draft.fields);
}

const inputClass = 'w-full min-w-0 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900 disabled:opacity-50';
const labels = { text: 'Text', number: 'Number', boolean: 'Yes / No', json: 'JSON (advanced)' };

export function ClassFieldsEditor({ value, onChange, disabled }: {
  value: ClassFieldsDraft; onChange(value: ClassFieldsDraft): void; disabled: boolean;
}) {
  const [modeError, setModeError] = useState('');
  const focusField = useRef<string | null>(null);
  const errors = validateClassFields(value.fields);
  let rawError = '';
  if (value.advanced) {
    try { parseClassSchema(value.raw); } catch (error) { rawError = error instanceof Error ? error.message : 'Invalid field definitions'; }
  }
  function change(next: ClassFieldsDraft) { setModeError(''); onChange(next); }
  function switchMode() {
    try {
      if (!value.advanced) {
        change({ ...value, advanced: true, raw: JSON.stringify(classFieldsToSchema(value.fields), null, 2) });
      } else {
        const fields = schemaToClassFields(parseClassSchema(value.raw));
        if (!fields) throw new Error('These definitions contain types or metadata the field table cannot represent. Keep editing JSON; nothing has been changed.');
        change({ ...value, advanced: false, fields: fields.map(field => ({ ...field, id: createClientId() })) });
      }
    } catch (error) { setModeError(error instanceof Error ? error.message : 'Cannot switch editor'); }
  }
  return <fieldset disabled={disabled} className="space-y-3">
    <legend className="text-sm font-medium text-gray-900 mb-2">Fields</legend>
    {value.advanced ? <div>
      <label htmlFor="class-fields-json" className="block text-xs text-gray-600 mb-1">Field definitions (JSON)</label>
      <p className="text-xs text-gray-600 mb-2">Advanced field map. Custom metadata is preserved; JSON Schema documents are not supported.</p>
      <textarea id="class-fields-json" rows={7} value={value.raw} spellCheck={false} aria-invalid={!!rawError}
        aria-describedby={rawError ? 'class-fields-json-error' : undefined} className={`${inputClass} font-mono`}
        onChange={event => change({ ...value, raw: event.target.value })} />
      {rawError && <p id="class-fields-json-error" role="alert" className="text-xs text-red-700">{rawError}</p>}
    </div> : <>
      {value.fields.length === 0 && <p className="text-xs text-gray-600">No fields yet. Add the information each entity should hold, or create a class without data fields.</p>}
      {value.fields.map((field, index) => <div key={field.id} className="space-y-1">
        <div className="flex gap-2 items-end">
          <label className="flex-1 min-w-0 text-xs text-gray-600">Field name
            <input aria-label={`Field ${index + 1} name`} value={field.name} aria-invalid={!!errors[index]}
              aria-describedby={errors[index] ? `field-error-${field.id}` : undefined} className={`${inputClass} mt-1`}
              ref={element => { if (element && focusField.current === field.id) { element.focus(); focusField.current = null; } }}
              onChange={event => change({ ...value, fields: value.fields.map(row => row.id === field.id ? { ...row, name: event.target.value } : row) })} />
          </label>
          <label className="flex-1 min-w-0 text-xs text-gray-600">Type
            <select aria-label={`Field ${index + 1} type`} value={field.type} className={`${inputClass} mt-1`}
              onChange={event => change({ ...value, fields: value.fields.map(row => row.id === field.id ? { ...row, type: event.target.value } : row) })}>
              {classFieldTypes.map(type => <option key={type} value={type}>{labels[type]}</option>)}
            </select>
          </label>
          <button type="button" aria-label={`Remove field ${index + 1}`} className="text-sm text-red-700 px-2 py-1.5"
            onClick={() => change({ ...value, fields: value.fields.filter(row => row.id !== field.id) })}>Remove</button>
        </div>
        {errors[index] && <p id={`field-error-${field.id}`} role="alert" className="text-xs text-red-700">{errors[index]}</p>}
        {field.type === 'json' && <p className="text-xs text-gray-600">For complex structured data. Entity forms will require a JSON value for this field.</p>}
      </div>)}
      <button type="button" className="text-sm text-teal-800" onClick={() => {
        const id = createClientId(); focusField.current = id;
        change({ ...value, fields: [...value.fields, { id, name: '', type: 'text' }] });
      }}>+ Add field</button>
    </>}
    <div className="border-t border-gray-200 pt-2">
      <button type="button" aria-expanded={value.advanced} onClick={switchMode} className="text-xs text-gray-600 underline">
        {value.advanced ? 'Use field table' : 'Advanced: edit JSON'}
      </button>
      {modeError && <p role="alert" className="mt-1 text-xs text-red-700">{modeError}</p>}
    </div>
  </fieldset>;
}
