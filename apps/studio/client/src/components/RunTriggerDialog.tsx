import { initialWorkflowInput, encodeWorkflowInputs, workflowInputErrors, focusWorkflowInput } from '../lib/workflow-inputs';
import { parseRunInputs, type RunInputEncoding, type RunInputSchema } from '@openhilo/itt-contracts/run-inputs';
import { useState, useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { WorkflowCombobox } from './WorkflowCombobox';
import { WorkflowParamInput } from './WorkflowParamInput';
import { listIntents, getIntentInfo } from '../api/entities';
import { startRun, suggestWorkdir } from '../api/runs';
import { useNavigate } from 'react-router-dom';
import { resolveIntentPrefill, resolveRetryIntent } from '../lib/intent-prefill';

interface IntentInfo {
  name: string;
  desc: string;
  ittPath: string;
  relativeIttPath?: string;
}

interface RetryDefaults {
  ittPath: string;
  workdir: string;
  inputs: Record<string, string>;
  inputEncoding?: RunInputEncoding;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  retryDefaults?: RetryDefaults;
  prefillIntent?: string; // intent name to pre-select in fresh mode
}

export function RunTriggerDialog({ open, onOpenChange, retryDefaults, prefillIntent }: Props) {
  const navigate = useNavigate();
  const isRetry = !!retryDefaults;
  const [tab, setTab] = useState<'fresh' | 'retry'>(isRetry ? 'retry' : 'fresh');

  const [intents, setIntents] = useState<IntentInfo[]>([]);
  const [selectedIttPath, setSelectedIttPath] = useState(retryDefaults?.ittPath ?? '');
  const [workdir, setWorkdir] = useState(retryDefaults?.workdir ?? '');
  const [workdirLoading, setWorkdirLoading] = useState(false);
  const [inputs, setInputs] = useState<Record<string, unknown>>(retryDefaults?.inputs ?? {});
  const [intentInputSchema, setIntentInputSchema] = useState<Record<string, unknown>>({});
  const [showInputErrors, setShowInputErrors] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [receiptWaitSeconds, setReceiptWaitSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);

  const requestVersion = useRef(0);
  const triggerElement = useRef<HTMLElement | null>(null);
  const workdirVersion = useRef(0);
  const workdirRead = useRef<AbortController | null>(null);
  const submission = useRef<object | null>(null);
  const [schemaReady, setSchemaReady] = useState(false);

  useEffect(() => {
    if (!open || !submitting) return;
    const started = Date.now();
    const timer = setInterval(() => setReceiptWaitSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [open, submitting]);

  async function refreshWorkdir(name: string) {
    const version = ++workdirVersion.current;
    workdirRead.current?.abort();
    const controller = new AbortController();
    workdirRead.current = controller;
    setWorkdirLoading(true);
    try { const next = await suggestWorkdir(name, controller.signal); if (version === workdirVersion.current) { setWorkdir(next); setError(previous => previous?.startsWith('Working directory:') ? null : previous); } }
    catch (e) { if (version === workdirVersion.current) setError(`Working directory: ${e instanceof Error ? e.message : String(e)}`); }
    finally { if (version === workdirVersion.current) setWorkdirLoading(false); }
  }

  async function loadIntentSchema(intentName: string, initEmpty: boolean) {
    const version = ++requestVersion.current;
    setSchemaReady(false); setError(null); setInputErrors({}); setShowInputErrors(false);
    try {
      const info = await getIntentInfo(intentName);
      if (version !== requestVersion.current) return;
      const schema = info.inputs ?? {};
      setIntentInputSchema(schema);
      setFormVersion(v => v + 1);
      if (initEmpty) {
        setInputs(Object.fromEntries(Object.keys(schema).map(k => {
          return [k, initialWorkflowInput(schema[k])];
        })));
      } else if (retryDefaults) {
        setInputs(parseRunInputs(retryDefaults.inputs, schema as RunInputSchema, retryDefaults.inputEncoding));
      }
      setSchemaReady(true);
    } catch (error) {
      if (version !== requestVersion.current) return;
      setError(String(error));
      setIntentInputSchema({});
    }
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSubmitting(false); setReceiptWaitSeconds(0);
    setTab(isRetry ? 'retry' : 'fresh'); setSchemaReady(false); setWorkdirLoading(false);
    setSelectedIttPath(retryDefaults?.ittPath ?? ''); setInputs({}); setIntentInputSchema({});
    setError(null); setPrefillNotice(null); setInputErrors({});
    if (retryDefaults) { setSelectedIttPath(retryDefaults.ittPath); setWorkdir(retryDefaults.workdir); }
    listIntents().then(list => {
      if (!active) return;
      setIntents(list);
      if (!isRetry && prefillIntent) {
        const found = resolveIntentPrefill(list, prefillIntent);
        if (found) {
          setSelectedIttPath(found.ittPath);
          void loadIntentSchema(found.name, true);
          void refreshWorkdir(found.name);
        } else setPrefillNotice(`The filter “${prefillIntent}” does not identify one available workflow. Select a workflow below.`);
      } else if (isRetry && retryDefaults) {
        const found = resolveRetryIntent(list, retryDefaults.ittPath);
        if (found) { setSelectedIttPath(found.ittPath); void loadIntentSchema(found.name, false); }
        else setError('The original intent is unavailable');
      }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; submission.current = null; requestVersion.current++; workdirVersion.current++; workdirRead.current?.abort(); };
  }, [open, isRetry, prefillIntent]);

  async function handleSubmit() {
    if (submission.current) return;
    if (!selectedIttPath) { setError('Select a workflow'); return; }
    if (!schemaReady || workdirLoading) return;
    if (!workdir) { setError('Workdir is required'); return; }

    // Validate required inputs
    const errs: Record<string, string> = workflowInputErrors(inputs, intentInputSchema);
    if (Object.keys(errs).length > 0) {
      setInputErrors(errs);
      return;
    }
    setInputErrors({});

    const owner = {};
    submission.current = owner;
    setSubmitting(true); setReceiptWaitSeconds(0);
    setError(null);
    let dispatched = false;
    try {
      const wire = encodeWorkflowInputs(inputs, intentInputSchema);
      dispatched = true;
      const { runId } = await startRun({ ittPath: selectedIttPath, workdir, inputs: wire, inputEncoding: 'typed-text-v1', suspend: true });
      if (submission.current !== owner) return;
      onOpenChange(false);
      navigate(`/runs/${runId}`);
    } catch (e) {
      if (submission.current !== owner) return;
      const message = e instanceof Error ? e.message : 'Failed to start run';
      const receiptUnknown = dispatched && (e instanceof TypeError || e instanceof SyntaxError);
      setError(receiptUnknown ? `${message}. Check History before trying again: the server may have accepted this run even though its receipt was not received.` : message);
    } finally {
      if (submission.current === owner) { submission.current = null; setSubmitting(false); }
    }
  }

  const selectedIntent = intents.find(i => i.ittPath === selectedIttPath);
  const validation = workflowInputErrors(inputs, intentInputSchema);
  const schemaEntries = Object.entries(intentInputSchema);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
        <Dialog.Content
          onOpenAutoFocus={() => { triggerElement.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={event => { if (triggerElement.current?.isConnected) { event.preventDefault(); triggerElement.current.focus(); } }}
          className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md sm:max-w-lg bg-gray-50 border border-gray-200 rounded-xl shadow-2xl flex flex-col max-h-[90vh] sm:max-h-[80vh]">
          {/* Header */}
          <div className="px-4 pt-4 border-b border-gray-200">
            <div className="flex justify-between items-center mb-3">
              <Dialog.Title className="text-base font-semibold text-gray-900">Run workflow</Dialog.Title>
              <Dialog.Description className="sr-only">Choose a workflow, review its inputs and working directory, then start a new run.</Dialog.Description>
              <Dialog.Close className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</Dialog.Close>
            </div>
            {isRetry && (
              <div className="flex">
                <button onClick={() => setTab('fresh')} className={`px-3 py-2 text-sm border-b-2 ${tab === 'fresh' ? 'border-blue-300 text-teal-800' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>New run</button>
                <button onClick={() => {
                  setTab('retry'); setSelectedIttPath(retryDefaults!.ittPath);
                  workdirVersion.current++; workdirRead.current?.abort(); setWorkdirLoading(false); setWorkdir(retryDefaults!.workdir);
                  const original = resolveRetryIntent(intents, retryDefaults!.ittPath);
                  if (original) { setSelectedIttPath(original.ittPath); void loadIntentSchema(original.name, false); }
                  else { requestVersion.current++; setSchemaReady(false); setError('The original intent is unavailable'); }
                }} className={`px-3 py-2 text-sm border-b-2 ${tab === 'retry' ? 'border-blue-300 text-teal-800' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>Run again</button>
              </div>
            )}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            <p className="text-sm text-gray-600">
              {tab === 'retry'
                ? 'Run again starts a new run from the beginning with the current workflow version, previous inputs and working directory. Completed steps may run again and repeat their effects.'
                : 'Start a new run from the beginning with the selected workflow and inputs.'}
              {' '}Changes to this form are discarded when you close it.
            </p>
            {/* Intent selector */}
            <div>

              {tab === 'retry' && retryDefaults ? (
                <div className="bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-500">
                  {retryDefaults.ittPath.split('/').pop()} (readonly)
                </div>
              ) : (
                <WorkflowCombobox items={intents} value={selectedIttPath} disabled={submitting}
                  onChange={ittPath => {
                    setPrefillNotice(null);
                    setSelectedIttPath(ittPath);
                    setInputErrors({});
                    const intent = intents.find(i => i.ittPath === ittPath);
                    if (intent) {
                      void loadIntentSchema(intent.name, true);
                      void refreshWorkdir(intent.name);
                    } else {
                      requestVersion.current++; workdirVersion.current++; workdirRead.current?.abort(); setSchemaReady(false); setWorkdirLoading(false);
                      setIntentInputSchema({});
                      setInputs({});
                    }
                  }} />
              )}
              {prefillNotice && <p role="status" className="mt-2 text-sm text-amber-700">{prefillNotice}</p>}
            </div>

            {/* Inputs */}
            <div>
              <div className="text-xs text-gray-600 uppercase mb-2">Inputs</div>
              {schemaEntries.length === 0 ? (
                <div className="text-xs text-gray-500 italic">
                  {selectedIttPath ? (schemaReady ? 'No inputs required' : 'Waiting for input schema') : 'Select a workflow to see parameters'}
                </div>
              ) : (
                <div className="space-y-3">
                  {schemaEntries.map(([key, schema]) => (
                    <WorkflowParamInput
                      key={`${formVersion}:${key}`}
                      definition={schema}
                      value={inputs[key]}
                      label={key}
                      error={inputErrors[key] ?? (showInputErrors ? validation[key] : undefined)}
                      disabled={submitting}
                      onChange={v => {
                        setInputs(prev => ({ ...prev, [key]: v }));
                        if (inputErrors[key]) setInputErrors(prev => { const n = { ...prev }; delete n[key]; return n; });
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Workdir */}
            <details>
              <summary className="cursor-pointer text-sm text-gray-600">Working directory (advanced)</summary>
              <div className="text-xs text-gray-600 uppercase mb-1">Workdir</div>
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900 font-mono"
                  aria-label="Workdir"
                  dir="ltr"
                  title={workdir}
                  value={workdirLoading ? '…' : workdir}
                  onChange={e => setWorkdir(e.target.value)}
                  disabled={submitting || workdirLoading}
                />
                <button
                  type="button"
                  disabled={submitting || workdirLoading}
                  onClick={() => {
                    const intentName = selectedIntent?.name ?? 'unknown';
                    void refreshWorkdir(intentName);
                  }}
                  className="px-3 py-1.5 text-xs bg-gray-50 text-gray-600 rounded hover:bg-gray-600 disabled:opacity-50"
                >
                  Generate new directory
                </button>
              </div>
            </details>

            {submitting && <div className="text-sm text-blue-900">
              <p role="status">Waiting for run creation receipt · {receiptWaitSeconds}s</p>
              <p className="mt-1 text-xs">The server has not confirmed this request yet. Do not submit it again. Closing this dialog does not cancel the request; check History before trying again.</p>
              {receiptWaitSeconds >= 30 && <p className="mt-1 text-xs text-amber-700">Taking longer than usual. The run's current state is unknown until its receipt arrives or you check History.</p>}
            </div>}
            {schemaReady && Object.keys(validation).length > 0 && <p role="status" className="text-sm text-gray-600">Check inputs: {Object.keys(validation).join(', ')}. <button type="button" className="underline text-teal-800" onClick={event => { setShowInputErrors(true); focusWorkflowInput(event.currentTarget.closest('[role=dialog]'), Object.keys(validation)[0], validation[Object.keys(validation)[0]]); }}>Review inputs</button></p>}
            {error && <div role="alert" className="text-sm text-red-700">{error}</div>}
          </div>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
            <Dialog.Close className="px-3 py-1.5 text-sm bg-gray-50 text-gray-600 rounded hover:bg-gray-600">{submitting ? 'Close' : 'Cancel'}</Dialog.Close>
            <button
              onClick={handleSubmit}
              disabled={submitting || !selectedIttPath || !schemaReady || workdirLoading || !workdir.trim() || Object.keys(validation).length > 0}
              className="px-4 py-1.5 text-sm bg-teal-700 text-white rounded hover:bg-teal-800 disabled:opacity-50"
            >
              {submitting ? 'Starting…' : tab === 'retry' ? 'Run again' : 'Run'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
