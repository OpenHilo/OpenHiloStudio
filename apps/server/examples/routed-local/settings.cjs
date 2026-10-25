const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { ConfigurationInputError } = require('@openhilo/platform-services/configuration-service');
const { parseAiExecutionConfig } = require('@openhilo/studio-contracts/ai-config');
const { readSelection, selectionFrom, rememberSelection } = require('./config.cjs');

function modelCatalog(selection) {
  const homes = new Set();
  for (const group of Object.values(selection.execution.routes)) for (const cell of Object.values(group.levels))
    if (cell.adapter === 'codex') homes.add(cell.codex_home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const models = new Map();
  for (const home of homes) try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    for (const m of cache.models || []) if (m.visibility === 'list' && typeof m.slug === 'string')
      models.set(m.slug, { model: m.slug, efforts: (m.supported_reasoning_levels || []).map(e => e.effort).filter(e => ['low','medium','high'].includes(e)) });
  } catch { /* Model cache is optional, never a dependency of saving or running. */ }
  return [...models.values()];
}
exports.createRoutingSettings = selection => {
  rememberSelection(selection);
  const file = path.join(selection.home, 'config.json');
  const read = () => {
    const saved = readSelection(selection.home);
    return structuredClone({ application: selection.application, ai_execution: selection.execution,
      saved_ai_execution: saved.execution, configuration_revision: saved.identity, codex_models: modelCatalog(saved),
      configuration_status: { activation: 'restart', restart_required: saved.identity !== selection.identity, editable: true } });
  };
  return { read, update(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['ai_execution','configuration_revision'].includes(k)))
      throw new ConfigurationInputError('Only AI routing rules may be edited in this deployment.');
    const current = readSelection(selection.home);
    if (input.configuration_revision !== current.identity) throw new ConfigurationInputError('Settings changed since this page was loaded. Reload settings before saving.');
    if (input.ai_execution?.adapter !== 'routed') throw new ConfigurationInputError('This deployment requires routed AI settings.');
    let execution;
    try { execution = parseAiExecutionConfig(input.ai_execution); }
    catch (error) { throw new ConfigurationInputError(error.message); }
    if (execution?.adapter !== 'routed') throw new ConfigurationInputError('This deployment requires routed AI settings.');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const updated = { ...raw, ai: { ...raw.ai, execution } };
    selectionFrom(selection.home, updated); // Validate the complete envelope before writing.
    rememberSelection(current);
    const temporary = path.join(selection.home, `.config.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return read();
  } };
};
