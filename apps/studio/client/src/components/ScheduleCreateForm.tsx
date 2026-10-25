import { useEffect, useRef, useState } from 'react';
import { listIntents, getIntentInfo } from '../api/entities';
import { suggestWorkdir } from '../api/runs';
import { getScheduleMeta } from '../api/schedules';
import { WorkflowParamInput } from './WorkflowParamInput';
import { WorkflowCombobox } from './WorkflowCombobox';
import { initialWorkflowInput, encodeWorkflowInputs, workflowInputErrors, focusWorkflowInput } from '../lib/workflow-inputs';
import { buildScheduleCron, type ScheduleFrequency } from '../lib/schedule-form';
import { parseScheduleInputs } from '../lib/schedule-inputs';

type CreateInput = Parameters<typeof import('../api/schedules').createSchedule>[0];
const control = 'w-full rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm text-gray-900 disabled:opacity-50';
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function ScheduleCreateForm({ pending, onCreate }: { pending: boolean; onCreate(input: CreateInput): Promise<void> }) {
  const [intents, setIntents] = useState<Awaited<ReturnType<typeof listIntents>>>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const nameEdited = useRef(false);
  const [workdir, setWorkdir] = useState('');
  const [schema, setSchema] = useState<Record<string, unknown>>({});
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [showInputErrors, setShowInputErrors] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [targetError, setTargetError] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [targetRetry, setTargetRetry] = useState(0);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<ScheduleFrequency>('daily');
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<number[]>([]);
  const [cron, setCron] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [manual, setManual] = useState(false);
  const [path, setPath] = useState('');
  const [rawInputs, setRawInputs] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError('');
    Promise.all([listIntents(), getScheduleMeta()]).then(([list, meta]) => {
      if (active) { setIntents(list); setTimeZone(meta.timeZone); }
    }).catch(e => { if (active) setLoadError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setShowInputErrors(false); setReady(false); setSchema({}); setValues({}); setTargetError('');
    if (!selected || manual) return () => { active = false; controller.abort(); };
    const intent = intents.find(item => item.ittPath === selected);
    if (!intent) return () => { active = false; controller.abort(); };
    setWorkdir('');
    if (!nameEdited.current) setName(intent.name);
    Promise.all([getIntentInfo(intent.name), suggestWorkdir(intent.name, controller.signal)]).then(([info, directory]) => {
      if (!active) return;
      setSchema(info.inputs); setValues(Object.fromEntries(Object.entries(info.inputs).map(([key, type]) => [key, initialWorkflowInput(type)])));
      setWorkdir(directory); setReady(true);
    }).catch(e => { if (active) setTargetError(e.message); });
    return () => { active = false; controller.abort(); };
  }, [selected, manual, intents, targetRetry]);

  const validation = workflowInputErrors(values, schema);
  const choice = intents.find(item => item.ittPath === selected);
  let expression = '', cronError = '';
  try { expression = buildScheduleCron(frequency, time, days, cron); } catch (e) { cronError = (e as Error).message; }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError('');
    try {
      if (cronError) throw new Error(cronError);
      if (!manual && (!ready || !choice)) throw new Error('Select a workflow and wait for its inputs to load.');
      const inputs = manual ? parseScheduleInputs(rawInputs) : encodeWorkflowInputs(values, schema);
      await onCreate({ name: name.trim(), cron: expression, ittPath: manual ? path.trim() : selected, workdir: workdir.trim(), inputs, enabled, inputEncoding: 'typed-text-v1' });
    } catch (e) { setError((e as Error).message); }
  }
  return <form onSubmit={submit} className="mb-6 max-w-xl rounded border border-gray-200 bg-gray-50 text-gray-900 p-4">
    <fieldset disabled={pending} className="space-y-4">
      <legend className="font-semibold text-gray-900 mb-3">Create schedule</legend>
      {loading && <p role="status">Loading workflows and execution time zone…</p>}
      {loadError && <p role="alert">{loadError} <button type="button" onClick={() => setRetry(v => v + 1)} className="underline">Retry loading</button></p>}
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={manual} onChange={e => { setManual(e.target.checked); setError(''); }} />Use a file path (advanced)</label>
      {manual ? <>
        <label className="block text-sm">Workflow file path<input required aria-label="Workflow file path" className={control} value={path} onChange={e => setPath(e.target.value)} /></label>
        <label className="block text-sm">Inputs (JSON object with string values, optional)<textarea aria-label="Inputs JSON" rows={3} className={control} value={rawInputs} onChange={e => setRawInputs(e.target.value)} /></label>
      </> : <>
        <WorkflowCombobox items={intents} value={selected} disabled={pending || loading || !!loadError}
          onChange={value => { setSelected(value); setError(''); }} />
        {choice?.desc && <p className="text-xs text-gray-600">{choice.desc}</p>}
        {selected && !ready && !targetError && <p role="status">Loading workflow inputs and working directory…</p>}
        {targetError && <p role="alert">{targetError} <button type="button" className="underline" onClick={() => setTargetRetry(v => v + 1)}>Retry workflow</button></p>}
        {ready && <div key={`${selected}:${targetRetry}`} className="space-y-3">
          <p className="text-sm font-medium">Workflow inputs</p>
          {!Object.keys(schema).length && <p className="text-xs text-gray-600">No inputs required.</p>}
          {Object.entries(schema).map(([key, type]) => <WorkflowParamInput key={key} label={key} definition={type} value={values[key]} disabled={pending} error={showInputErrors ? validation[key] : undefined}
            onChange={value => setValues(previous => ({ ...previous, [key]: value }))}
          />)}
        </div>}
      </>}
      <label className="block text-sm">Schedule name<input required aria-label="Schedule name" className={control} value={name} onChange={e => { nameEdited.current = true; setName(e.target.value); }} /></label>
      <label className="block text-sm">Frequency<select aria-label="Frequency" className={control} value={frequency} onChange={e => setFrequency(e.target.value as ScheduleFrequency)}>
        <option value="daily">Every day</option><option value="weekly">Every week</option><option value="advanced">Advanced Cron</option>
      </select></label>
      {frequency === 'advanced' ? <label className="block text-sm">Cron expression<input required aria-label="Cron expression" className={control} placeholder="0 9 * * 1-5" value={cron} onChange={e => setCron(e.target.value)} /></label>
        : <label className="block text-sm">Execution time<input required type="time" aria-label="Execution time" className={control} value={time} onChange={e => setTime(e.target.value)} /></label>}
      {frequency === 'weekly' && <fieldset><legend className="text-sm text-gray-900">Days of week</legend><div className="flex flex-wrap gap-3 mt-1">
        {[1, 2, 3, 4, 5, 6, 0].map(day => <label key={day} className="text-sm flex gap-1"><input type="checkbox" checked={days.includes(day)} onChange={e => setDays(previous => e.target.checked ? [...previous, day] : previous.filter(item => item !== day))} />{weekdays[day]}</label>)}
      </div></fieldset>}
      <p className="text-xs text-gray-600">Execution time zone: {timeZone ?? 'not reported by server'}{!timeZone && !loading && '. Use advanced Cron only if you know the server clock configuration.'}</p>
      <details open={manual || undefined}><summary className="text-sm cursor-pointer">Working directory {workdir ? '(suggested, editable)' : ''}</summary>
        <input required aria-label="Working directory" className={control} value={workdir} onChange={e => setWorkdir(e.target.value)} />
        <p className="text-xs text-gray-600 mt-1">Each trigger of this schedule uses this same directory.</p>
      </details>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enable after creation</label>
      <p className="text-sm" aria-label="Schedule summary">{frequency === 'daily' ? `Every day at ${time}` : frequency === 'weekly' ? `Every ${days.map(day => weekdays[day]).join(', ') || '(choose weekdays)'} at ${time}` : `Cron: ${cron || '(enter expression)'}`} · {timeZone ?? 'server time zone'} · {manual ? path || '(choose file)' : choice?.name ?? '(choose workflow)'} · {enabled ? 'Enabled after creation' : 'Created disabled'}</p>
      {!manual && ready && Object.keys(validation).length > 0 && <p role="status" className="text-sm text-gray-600">Check inputs: {Object.keys(validation).join(', ')}. <button type="button" className="underline text-teal-800" onClick={event => { setShowInputErrors(true); focusWorkflowInput(event.currentTarget.closest('form'), Object.keys(validation)[0], validation[Object.keys(validation)[0]]); }}>Review inputs</button></p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {cronError && <p className="text-xs text-red-700">{cronError}</p>}
      <button type="submit" disabled={pending || loading || !!loadError || (!manual && !ready) || !!cronError || (!timeZone && frequency !== 'advanced') || (!manual && !!Object.keys(validation).length) || !name.trim() || !workdir.trim() || (manual && !path.trim())} className="rounded px-3 py-1.5 text-sm bg-teal-700 text-white disabled:opacity-50">{pending ? 'Creating…' : enabled ? 'Create and enable' : 'Create disabled'}</button>
    </fieldset>
  </form>;
}
