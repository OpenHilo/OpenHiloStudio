import { useId, useState } from 'react';

interface Option { label: string; value: string; recommended?: boolean; reason?: string }
export function QuestionAnswerInput({ options = [], exclusive = false, selected, onSelect, text, onText, disabled, json = false, onSubmit }: {
  options?: Option[]; exclusive?: boolean; selected: string | null; onSelect(value: string | null): void;
  text: string; onText(value: string): void; disabled: boolean; json?: boolean; onSubmit?(): void;
}) {
  const id = useId();
  const [custom, setCustom] = useState(selected === null && text.length > 0);
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="sr-only">Your answer</legend>
    {options.map((option, index) => <label key={index} className={`flex items-start gap-2 border rounded p-3 cursor-pointer ${selected === option.value && !custom ? 'border-blue-300 bg-blue-500/10' : 'border-gray-400'}`}>
      <input type="radio" name={id} checked={selected === option.value && !custom} onChange={() => { setCustom(false); onSelect(option.value); }} />
      <span><span>{option.label}{option.recommended ? ' (recommended)' : ''}</span>{option.reason && <span className="block text-xs opacity-80 mt-1">{option.reason}</span>}</span>
    </label>)}
    {options.length > 0 && !exclusive && <label className="flex gap-2 items-center text-sm">
      <input type="radio" name={id} checked={custom} onChange={() => { setCustom(true); onSelect(null); }} />Write my own answer
    </label>}
    {(!options.length || (custom && !exclusive)) && <label className="block text-sm">{json ? 'Your answer (JSON)' : 'Your answer'}
      <textarea aria-label={json ? 'Your answer (JSON)' : 'Your answer'} value={text} onChange={event => onText(event.target.value)} rows={3}
        onKeyDown={event => { if (onSubmit && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); onSubmit(); } }}
        className="mt-1 w-full rounded border border-gray-400 bg-transparent p-2 text-sm" />
      {onSubmit && <span className="block mt-1 text-xs opacity-80">Enter to send. Shift+Enter for a new line.</span>}
    </label>}
  </fieldset>;
}
