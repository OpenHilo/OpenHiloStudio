import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { TagDefinition } from '../api/entities';

import type { StudioApplication } from '@openhilo/studio-contracts';
import { studioTones } from '../lib/studio-tones';

interface TagBadgeProps {
  presentation?: StudioApplication['tags'][string];
  tagName: string;
  value: string;
  entityName?: string;
  tagDef?: TagDefinition;
  onChangeConfirmed?: (newValue: string) => void | Promise<void>;
}

export function TagBadge({ presentation, tagName, value, entityName, tagDef, onChangeConfirmed }: TagBadgeProps) {
  const busy = useRef(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(value);
  const clickable = presentation?.inlineEditable === true && !!tagDef && !!onChangeConfirmed;
  const colorClass = studioTones[presentation?.tone ?? 'neutral'];

  async function handleConfirm() {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError(null);
    try { await onChangeConfirmed?.(pending); setOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to save tag. Try again.'); }
    finally { busy.current = false; setSaving(false); }
  }
  const badgeClass = `inline-flex items-center text-[10px] font-medium rounded px-1.5 py-0.5 ${colorClass}`;
  const badge = clickable ? <button type="button" className={`${badgeClass} underline hover:opacity-75`}
    aria-label={`Edit ${tagName}: ${value}`} onClick={() => { setPending(value); setError(null); setOpen(true); }}>{value} <span aria-hidden="true" className="ml-1">✎</span></button>
    : <span className={badgeClass}>{value}</span>;

  if (!clickable) return badge;

  return (
    <Dialog.Root open={open} onOpenChange={next => { if (!busy.current) setOpen(next); }}>
      <Dialog.Trigger asChild>{badge}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-72 bg-gray-50 border border-gray-200 rounded-lg shadow-xl p-4">
          <Dialog.Title className="text-sm font-semibold text-gray-900 mb-1">
            Change <code className="text-xs text-teal-800">{tagName}</code>
          </Dialog.Title>
          <Dialog.Description className="sr-only">Choose a new tag value and confirm to save it.</Dialog.Description>
          {entityName && <p className="text-xs text-gray-500 mb-3">on <strong className="text-gray-600">{entityName}</strong></p>}
          <div className="mb-4">
            <div className="text-xs text-gray-600 mb-1">New value</div>
            <select disabled={saving} aria-label="New value"
              className="w-full bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900"
              value={pending}
              onChange={e => setPending(e.target.value)}
            >
              {(tagDef?.allowedValues ?? [value]).map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
          {error && <p role="alert" className="text-sm text-red-700 mb-3">{error}</p>}
          {saving && <p role="status" className="text-sm text-gray-600 mb-3">Saving tag…</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close disabled={saving} className="px-3 py-1.5 text-xs bg-gray-50 text-gray-600 rounded">Cancel</Dialog.Close>
            <button
              onClick={handleConfirm}
              disabled={saving || pending === value}
              className="px-3 py-1.5 text-xs bg-teal-700 text-white rounded disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
