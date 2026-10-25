const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseDeploymentConfig } = require('@openhilo/platform-services/deployment-config');
const { parseAiExecutionConfig } = require('@openhilo/studio-contracts/ai-config');
const { CodexTaskExecutor } = require('@openhilo/ai-codex');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function readSelection(home) {
  if (!home || !path.isAbsolute(home)) throw new Error('Codex deployment requires an explicit absolute home');
  home = fs.realpathSync(home);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); }
  catch { throw new Error('Could not read Codex deployment configuration'); }
  const config = parseDeploymentConfig(raw);
  const application = config.domain.selection;
  if (application.id !== 'generic' || application.version !== 1 || Object.keys(application).some(key => !['id', 'version'].includes(key)))
    throw new Error('Codex local preset requires explicit generic application version 1');
  const execution = parseAiExecutionConfig(config.ai.execution);
  if (execution?.adapter !== 'codex') throw new Error('Codex local preset requires explicit Codex execution');
  const identity = 'intentorch.codex-local.v1:' + createHash('sha256').update(JSON.stringify(canonical({ application, execution }))).digest('hex');
  return { home, application, execution, identity };
}
function createExecutor(selection) {
  const c = selection.execution;
  return new CodexTaskExecutor({ id: selection.identity, cliPath: c.cli_path, model: c.model,
    effort: c.effort, sandbox: c.sandbox, codexHome: c.codex_home, timeoutMs: c.timeout_ms });
}
module.exports = { readSelection, createExecutor };
