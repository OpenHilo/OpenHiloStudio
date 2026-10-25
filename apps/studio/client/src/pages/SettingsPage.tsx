import { AiRoutesEditor } from '../components/AiRoutesEditor';
import { validateRoutes, type RoutedExecutionConfig } from '../lib/ai-routes';
import { useBlocker } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { getConfig, updateConfig, type AiExecutionConfig, type SdkProfileConfig, type IttConfig } from '../api/config';

import { profileDrafts, settingsDraftKey, type ProfileDraft } from '../lib/settings-draft';
const fieldClass = 'w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm';

export interface StudioSettingsExtension {
  id: string;
  label: string;
  matchesLegacyConfig?: (config: Record<string, unknown>) => boolean;
  Editor: React.ComponentType<{
    config: Record<string, unknown>;
    savedConfig: Record<string, unknown>;
    onChange: (patch: Record<string, unknown>) => void;
    onValidityChange: (valid: boolean) => void;
  }>;
  createPatch: (config: Record<string, unknown>) => Record<string, unknown>;
}
const noExtensions: readonly StudioSettingsExtension[] = [];

export function SettingsPage({ extensions = noExtensions }: { extensions?: readonly StudioSettingsExtension[] }) {
  const [adapter, setAdapter] = useState('');
  const [routes, setRoutes] = useState<RoutedExecutionConfig>();
  const [profiles, setProfiles] = useState<ProfileDraft[]>([]);
  const [defaultProfile, setDefaultProfile] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<IttConfig>({});
  const [extensionPatch, setExtensionPatch] = useState<Record<string, Record<string, unknown>>>({});
  const [extensionValid, setExtensionValid] = useState(true);
  const extension = extensions.find(item => item.id === adapter);
  const [saved, setSaved] = useState(false);
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  function extensionValue(id: string, cfg: IttConfig, patch: Record<string, unknown> = {}) {
    const editor = extensions.find(item => item.id === id);
    const merged = { ...cfg, ...patch };
    // An invalid intermediate draft still needs protection if its editor cannot build a patch.
    try { return editor ? editor.createPatch(merged) : merged; } catch { return merged; }
  }
  const dirty = savedDraft !== null && savedDraft !== settingsDraftKey(adapter, routes, profiles, defaultProfile,
    adapter === 'routed' || adapter === 'sdk' ? undefined : extensionValue(adapter, config, extensionPatch[adapter]));

  function acceptSavedConfig(cfg: IttConfig) {
    const execution = cfg.saved_ai_execution ?? cfg.ai_execution;
    const selected = execution?.adapter ?? extensions.find(item => item.matchesLegacyConfig?.(cfg))?.id ?? '';
    const nextProfiles = profileDrafts(execution);
    const nextDefault = execution?.adapter === 'sdk' ? execution.default_profile : '';
    const nextRoutes = execution?.adapter === 'routed' ? execution : undefined;
    setConfig(cfg); setAdapter(selected); setRoutes(nextRoutes);
    setProfiles(nextProfiles); setDefaultProfile(nextDefault); setExtensionPatch({});
    setSavedDraft(settingsDraftKey(selected, nextRoutes, nextProfiles, nextDefault,
      selected === 'routed' || selected === 'sdk' ? undefined : extensionValue(selected, cfg)));
  }
  const blocker = useBlocker(dirty || saving);
  const leaveNotice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (blocker.state === 'blocked' && !dirty && !saving) blocker.proceed();
  }, [blocker, dirty, saving]);
  useEffect(() => { if (blocker.state === 'blocked') leaveNotice.current?.focus(); }, [blocker.state]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, saving]);
  const [saveError, setSaveError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    getConfig(controller.signal)
      .then(cfg => {
        if (!active) return;
        acceptSavedConfig(cfg);
        setLoading(false);
      })
      .catch((err: Error) => { if (active) { setLoadError(err.message); setLoading(false); } });
    return () => { active = false; controller.abort(); };
  }, [extensions, reload]);

  function updateProfile(index: number, patch: Partial<ProfileDraft>) {
    setProfiles(current => current.map((profile, i) => i === index ? { ...profile, ...patch } : profile));
    if (patch.name !== undefined && profiles[index].name === defaultProfile) setDefaultProfile(patch.name);
    setSaved(false);
  }
  function addProfile() {
    let suffix = profiles.length + 1;
    while (profiles.some(profile => profile.name === `profile-${suffix}`)) suffix++;
    const name = `profile-${suffix}`;
    setProfiles(current => [...current, { name, provider: 'openai', model: '', keyEnv: 'OPENAI_API_KEY', baseUrl: '', maxTokens: '' }]);
    if (!defaultProfile) setDefaultProfile(name);
    setSaved(false);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (config.configuration_status?.editable === false || saving || !dirty) return;
    setSaveError('');
    setSaved(false);
    setSaving(true);
    try {
      let patch: Record<string, unknown>;
      if (adapter === 'routed' && routes) {
        const error = validateRoutes(routes); if (error) throw new Error(error);
        patch = { ai_execution: routes, configuration_revision: config.configuration_revision };
      } else if (adapter === 'sdk') {
        if (!profiles.length || new Set(profiles.map(profile => profile.name)).size !== profiles.length) throw new Error('Add profiles with unique names.');
        const entries = profiles.map((profile): [string, SdkProfileConfig] => [profile.name, {
          provider: profile.provider, model: profile.model.trim(), api_key_env: profile.keyEnv.trim(),
          ...(profile.baseUrl.trim() ? { base_url: profile.baseUrl.trim() } : {}),
          ...(profile.maxTokens.trim() ? { max_output_tokens: Number(profile.maxTokens) } : {}),
        }]);
        const ai_execution: AiExecutionConfig = { adapter: 'sdk', default_profile: defaultProfile, profiles: Object.fromEntries(entries) };
        patch = { ai_execution };
      } else {
        if (!extension || !extensionValid) throw new Error('Select an available executor and correct its settings.');
        patch = extension.createPatch({ ...config, ...extensionPatch[adapter] });
      }
      const updated = await updateConfig(patch);
      acceptSavedConfig(updated);
      setSaved(true);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally { setSaving(false); }
  }

  if (loading) return <div role="status" className="text-gray-500 dark:text-gray-400">Loading settings…</div>;

  if (loadError) return <div><h1 className="text-2xl font-bold mb-6">Settings</h1><p role="alert" className="text-red-600">{loadError} <button className="underline" onClick={() => setReload(value => value + 1)}>Retry settings</button></p></div>;

  const restartActivation = config.configuration_status?.activation === 'restart';
  const restartRequired = restartActivation && config.configuration_status?.restart_required === true;
  const readOnly = config.configuration_status?.editable === false;
  const routeError = adapter === 'routed' && routes ? validateRoutes(routes) : undefined;
  const canSave = dirty && !readOnly && !saving && (adapter === 'sdk' || (adapter === 'routed' && Boolean(routes) && !routeError) || Boolean(extension && extensionValid));

  return (
    <div className="max-w-3xl">
      <header className="page-heading"><div><h1>Settings</h1><p>Choose the AI models for your workflows.</p></div></header>
      {blocker.state === 'blocked' && <div ref={leaveNotice} tabIndex={-1} role="alert" className="mb-4 rounded border border-amber-400 p-3">
        <p>{saving ? 'Settings are being saved. Wait for the result before leaving.' : 'You have unsaved changes. Leave and discard them?'}</p>
        <button type="button" className="underline mr-4" onClick={() => blocker.reset()}>Keep editing</button>
        {!saving && <button type="button" className="underline" onClick={() => blocker.proceed()}>Discard and leave</button>}
      </div>}
      {dirty && !saving && <p role="status" className="mb-3 text-sm text-amber-700">Unsaved changes</p>}
      {readOnly && <p role="status" className="mb-4 rounded border border-gray-400 p-3 text-sm">This deployment uses read-only settings. Edit config.json in its deployment home and restart the server to apply changes. The executor shown below is the active configuration.</p>}
      {!readOnly && <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">{restartActivation ? 'Save changes, then restart when work is idle to activate them.' : 'Save changes to apply them to new work.'}</p>}
      {restartRequired && <p role="status" className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Saved changes are pending. Restart the server when work is idle to apply them. Existing runs retain their original routing configuration.</p>}
      <form onSubmit={handleSave} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 space-y-6">
        <fieldset disabled={readOnly || saving} className="space-y-6 min-w-0">

        {adapter !== 'routed' && <div>
          <label htmlFor="ai-adapter" className="block text-sm font-medium mb-1">AI executor</label>
          <select id="ai-adapter" disabled={config.ai_execution?.adapter === 'routed'} value={adapter} onChange={e => {
            setAdapter(e.target.value); setSaved(false); setSaveError(''); setExtensionValid(true);
          }} className={fieldClass}>
            {adapter === 'routed' && <option value="routed">Task type / level routing</option>}
            <option value="sdk">OpenAI / Anthropic SDK</option>
            {extensions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            {adapter !== 'sdk' && adapter !== 'routed' && !extension && <option value={adapter} disabled>{adapter || 'Unspecified executor'}{readOnly ? '' : ' (editor unavailable)'}</option>}
          </select>
          <p className="mt-1 text-xs text-gray-500">{restartActivation ? 'Changes take effect after a server restart. Existing work keeps its current configuration until then.' : 'Applies to new runs and generation sessions. Existing runs keep their saved executor.'}</p>
        </div>}

        {readOnly && config.ai_execution?.adapter === 'codex' && <section aria-label="Active Codex configuration">
          <h2 className="text-sm font-semibold mb-3">Active Codex configuration</h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt>Model</dt><dd className="break-words">{config.ai_execution.model ?? 'CLI default (from your Codex configuration)'}</dd>
            <dt>Reasoning effort</dt><dd>{config.ai_execution.effort ?? 'CLI default'}</dd>
            <dt>Sandbox</dt><dd>{config.ai_execution.sandbox ?? 'workspace-write'}</dd>
            <dt>Active-time limit</dt><dd>{config.ai_execution.timeout_ms ?? 43200000} ms{config.ai_execution.timeout_ms === undefined || config.ai_execution.timeout_ms === 43200000 ? ' (12 hours)' : ''}</dd>
            <dt>Executable</dt><dd className="break-all">{config.ai_execution.cli_path ?? 'codex (from server PATH)'}</dd>
          </dl>
          <p className="mt-3 text-xs text-gray-500">Edit ai.execution in your deployment home’s config.json, then restart when work is idle. Time waiting for your answers does not count toward the active-time limit.</p>
        </section>}

        {adapter === 'routed' && routes && <>
          {restartRequired && config.ai_execution?.adapter === 'routed' && <details className="rounded border p-3 text-sm">
            <summary className="cursor-pointer">View currently active routes</summary>
            <ul className="mt-2 space-y-1">{Object.entries(config.ai_execution.routes).flatMap(([type, group]) => group ? Object.entries(group.levels).map(([level, cell]) => cell && <li key={`${type}/${level}`}>{type}/{level}: {cell.adapter === 'codex' ? `${cell.model || 'CLI default'} · ${cell.effort || 'default'} reasoning` : cell.profiles[cell.default_profile].model}</li>) : [])}</ul>
          </details>}
          <AiRoutesEditor value={routes} models={config.codex_models} onChange={next => { setRoutes(next); setSaved(false); setSaveError(''); }} />
          {routeError && <p role="alert" className="text-sm text-red-600">{routeError}</p>}
        </>}

        {adapter === 'sdk' && <div className="space-y-4">
          <p className="text-sm text-gray-500">Configure model profiles. API keys are read from the server environment; enter the variable name below, never the key itself.</p>
          {profiles.map((profile, index) => <fieldset key={index} className="border border-gray-300 dark:border-gray-600 rounded p-3 space-y-3">
            <legend className="px-1 text-sm">Profile {index + 1}</legend>
            <label className="block text-sm">Profile name
              <input className={fieldClass} value={profile.name} onChange={e => updateProfile(index, { name: e.target.value })} required />
            </label>
            <label className="block text-sm">Provider
              <select className={fieldClass} value={profile.provider} onChange={e => {
                const provider = e.target.value as 'openai' | 'anthropic';
                updateProfile(index, { provider, keyEnv: provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY' });
              }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select>
            </label>
            <label className="block text-sm">Model name
              <input className={fieldClass} value={profile.model} onChange={e => updateProfile(index, { model: e.target.value })} required />
            </label>
            <label className="block text-sm">API key environment variable
              <input className={fieldClass} value={profile.keyEnv} onChange={e => updateProfile(index, { keyEnv: e.target.value })} required autoComplete="off" />
            </label>
            <label className="block text-sm">API base URL (optional)
              <input type="url" className={fieldClass} value={profile.baseUrl} onChange={e => updateProfile(index, { baseUrl: e.target.value })} placeholder="Provider default" />
            </label>
            <label className="block text-sm">Maximum output tokens (optional)
              <input type="number" min={1} step={1} className={fieldClass} value={profile.maxTokens} onChange={e => updateProfile(index, { maxTokens: e.target.value })} />
            </label>
            <button type="button" className="text-sm text-red-600" onClick={() => {
              const remaining = profiles.filter((_, i) => i !== index); setProfiles(remaining);
              if (defaultProfile === profile.name) setDefaultProfile(remaining[0]?.name ?? ''); setSaved(false);
            }}>Remove profile</button>
          </fieldset>)}
          <button type="button" className="text-sm text-teal-700" onClick={addProfile}>Add profile</button>
          <label className="block text-sm">Default profile
            <select className={fieldClass} value={defaultProfile} onChange={e => { setDefaultProfile(e.target.value); setSaved(false); }} required>
              <option value="" disabled>Select a profile</option>
              {profiles.map((profile, i) => <option key={i} value={profile.name}>{profile.name}</option>)}
            </select>
          </label>
        </div>}

        {extension && <extension.Editor key={adapter} config={{ ...config, ...extensionPatch[adapter] }} savedConfig={config}
          onChange={patch => { setExtensionPatch(current => ({ ...current, [adapter]: { ...current[adapter], ...patch } })); setSaved(false); setSaveError(''); }}
          onValidityChange={setExtensionValid} />}
        {!readOnly && adapter !== 'sdk' && adapter !== 'routed' && !extension && <p role="alert">The settings editor for this executor is not installed. Select an available executor to configure new runs.</p>}

        {saveError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canSave}
            className="px-4 py-2 bg-teal-700 hover:bg-teal-800 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && <span role="status" className="text-sm text-green-600 dark:text-green-400">{restartRequired ? 'Saved · pending restart' : 'Saved'}</span>}
        </div>
        </fieldset>
      </form>
    </div>
  );
}
