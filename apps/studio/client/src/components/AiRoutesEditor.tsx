import { AI_TYPES, AI_LEVELS, type AiType, type AiLevel, type RoutedExecutionConfig, type DirectAiExecutionConfig,
  setRouteCell } from '../lib/ai-routes';
const fieldClass = 'w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm';
export function AiRoutesEditor({ value, onChange, models = [] }: {
  value: RoutedExecutionConfig; onChange: (config: RoutedExecutionConfig) => void;
  models?: { model: string; efforts: string[] }[];
}) {
  const edit = (apply: (next: RoutedExecutionConfig) => void) => { const next = structuredClone(value); apply(next); onChange(next); };
  const update = (type: AiType, level: AiLevel, patch: Partial<DirectAiExecutionConfig>) => onChange(setRouteCell(value, type, level, patch));
  return <section aria-label="AI routing rules" className="route-editor">
    <datalist id="codex-route-models">{models.map(m => <option key={m.model} value={m.model} />)}</datalist>
    {AI_TYPES.map(type => {
      const group = value.routes[type]; if (!group) return null;
      return <details key={type} open={type === 'default'} className="route-type">
        <summary className="route-type-heading"><span className="route-type-name">{type}</span><span className="route-type-meta">Default: {group.defaultLevel}</span></summary>
        <div className="route-type-body">
          <div className="route-default-control">
            <label className="text-sm">Default level
              <select aria-label={`Default level for ${type}`} className={fieldClass} value={group.defaultLevel} onChange={e => edit(next => { next.routes[type]!.defaultLevel = e.target.value as AiLevel; })}>
                {AI_LEVELS.filter(l => group.levels[l]).map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          </div>
          {AI_LEVELS.map(level => {
            const cell = group.levels[level]; if (!cell) return null;
            return <details key={level} className="route-level">
              <summary className="route-level-heading"><span className="route-level-name">{level}{level === group.defaultLevel && <span className="route-default-badge">Default</span>}</span><span className="route-model-name">{cell.adapter === 'codex' ? cell.model || 'CLI default' : cell.profiles[cell.default_profile]?.model}</span></summary>
              <div className="route-level-body">
                {cell.adapter === 'codex' ? <><div className="route-fields">
                  <label className="block text-sm">Model
                    <input aria-label={`Model for ${type}/${level}`} className={fieldClass} list="codex-route-models" value={cell.model ?? ''} placeholder="Codex CLI default" onChange={e => {
                      const next = structuredClone(value); const c = next.routes[type]!.levels[level]!;
                      if (c.adapter === 'codex') { if (e.target.value.trim()) c.model = e.target.value.trim(); else delete c.model; } onChange(next);
                    }} />
                  </label>
                  <label className="block text-sm">Reasoning
                    <select aria-label={`Reasoning for ${type}/${level}`} className={fieldClass} value={cell.effort ?? ''} onChange={e => {
                      const next = structuredClone(value); const c = next.routes[type]!.levels[level]!;
                      if (c.adapter === 'codex') { if (e.target.value) c.effort = e.target.value as 'low' | 'medium' | 'high'; else delete c.effort; } onChange(next);
                    }}><option value="">Codex default</option>{['low','medium','high'].map(e => <option key={e} value={e}>{e}</option>)}</select>
                  </label>
                </div><details className="route-advanced"><summary>Advanced</summary><div className="route-fields">
                  <label className="block text-sm">Time limit (hours)
                    <input aria-label={`Time limit for ${type}/${level}`} title="Waiting for answers pauses this timer" className={fieldClass} type="number" min={1 / 3600000} max={2147483647 / 3600000} step="any" value={cell.timeout_ms === undefined ? '' : cell.timeout_ms / 3600000} placeholder="12" onChange={e => {
                      const next = structuredClone(value); const c = next.routes[type]!.levels[level]!;
                      if (!e.target.value) delete c.timeout_ms; else c.timeout_ms = Math.round(Number(e.target.value) * 3600000); onChange(next);
                    }} />
                  </label>
                  <label className="block text-sm">Sandbox
                    <select aria-label={`Sandbox for ${type}/${level}`} className={fieldClass} value={cell.sandbox ?? 'workspace-write'} onChange={e => update(type, level, { sandbox: e.target.value as 'read-only' | 'workspace-write' })}>
                      <option value="workspace-write">Workspace write</option><option value="read-only">Read only</option>
                    </select>
                  </label>
                </div>
                {Object.keys(group.levels).length > 1 && <button type="button" className="text-sm text-red-600" onClick={() => edit(next => {
                  const g = next.routes[type]!; delete g.levels[level]; if (g.defaultLevel === level) g.defaultLevel = AI_LEVELS.find(l => g.levels[l])!;
                })}>Remove level</button>}
                </details></> : <p className="text-sm">SDK profile: {cell.default_profile}</p>}
              </div>
            </details>;
          })}
          {(type !== 'default' || AI_LEVELS.some(l => !group.levels[l])) && <details className="route-manage"><summary>Manage levels</summary><div className="route-manage-body">
          {AI_LEVELS.some(l => !group.levels[l]) && <label className="block text-sm">Add level
            <select aria-label={`Add level to ${type}`} className={fieldClass} value="" onChange={e => edit(next => { next.routes[type]!.levels[e.target.value as AiLevel] = structuredClone(group.levels[group.defaultLevel]!); })}>
              <option value="" disabled>Select a level</option>{AI_LEVELS.filter(l => !group.levels[l]).map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>}
          {type !== 'default' && <button type="button" className="text-sm text-red-600" onClick={() => edit(next => { delete next.routes[type]; })}>Remove type</button>}
          </div></details>}
        </div>
      </details>;
    })}
    {AI_TYPES.some(t => !value.routes[t]) && <label className="block text-sm">Add task type
      <select className={fieldClass} value="" onChange={e => edit(next => { next.routes[e.target.value as AiType] = structuredClone(next.routes.default!); })}>
        <option value="" disabled>Select a type</option>{AI_TYPES.filter(t => !value.routes[t]).map(t => <option key={t} value={t}>{t}</option>)}
      </select>
    </label>}
  </section>;
}
