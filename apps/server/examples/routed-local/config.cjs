const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseDeploymentConfig } = require('@openhilo/platform-services/deployment-config');
const { parseAiExecutionConfig } = require('@openhilo/studio-contracts/ai-config');
const { CodexTaskExecutor } = require('@openhilo/ai-codex');
const { createSdkTaskExecutor } = require('@openhilo/ai-sdk');
const { configureAiRouting } = require('@openhilo/ai-contracts/routing');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function readSelection(home) {
  if (!home || !path.isAbsolute(home)) throw new Error('Routed deployment requires an explicit absolute home');
  home = fs.realpathSync(home);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); }
  catch { throw new Error('Could not read Routed deployment configuration'); }
  return selectionFrom(home, raw);
}
function selectionFrom(home, raw) {
  const config = parseDeploymentConfig(raw);
  const application = config.domain.selection;
  if (application.id !== 'generic' || application.version !== 1 || Object.keys(application).some(key => !['id', 'version'].includes(key)))
    throw new Error('Routed local preset requires explicit generic application version 1');
  const execution = parseAiExecutionConfig(config.ai.execution);
  if (execution?.adapter !== 'routed') throw new Error('Routed local preset requires explicit routed execution');
  const identity = 'intentorch.routed-local.v1:' + createHash('sha256').update(JSON.stringify(canonical({ application, execution }))).digest('hex');
  return { home, application, execution, identity };
}
function createExecutor(selection, env = process.env) {
  return configureAiRouting(selection.execution.routes, c => {
    let executor;
    if (c.adapter === 'codex') executor = new CodexTaskExecutor({ cliPath: c.cli_path, model: c.model,
      effort: c.effort, sandbox: c.sandbox, codexHome: c.codex_home, timeoutMs: c.timeout_ms });
    else {
      const profiles = Object.fromEntries(Object.entries(c.profiles).map(([name,p]) => {
        const apiKey = env[p.api_key_env];
        if (!apiKey?.trim()) throw new Error('Missing SDK credential environment variable for configured route');
        return [name,{provider:p.provider,model:p.model,apiKey,baseURL:p.base_url,maxOutputTokens:p.max_output_tokens}];
      }));
      executor = createSdkTaskExecutor(profiles,c.default_profile,{timeoutMs:c.timeout_ms});
    }
    return {executor,identity:c};
  });
}
function revisionPath(home, identity) {
  if (!/^intentorch\.routed-local\.v1:[a-f0-9]{64}$/.test(identity)) throw new Error('Invalid saved AI routing identity');
  return path.join(home, '.ai-routing', identity.split(':')[1] + '.json');
}
function rememberSelection(selection) {
  const file = revisionPath(selection.home, selection.identity);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const value = { application: selection.application, execution: selection.execution };
  try { fs.writeFileSync(file, JSON.stringify(value), {flag:'wx',mode:0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  readSavedSelection(selection.home, selection.identity); // A damaged revision must not be accepted.
}
function readSavedSelection(home, identity) {
  const file = revisionPath(home, identity);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = selectionFrom(home, {format:'intentorch.deployment',version:1,core:{legacyFields:{}},
    domain:{selection:saved.application,applications:{}},ai:{execution:saved.execution,implementations:{}},legacy:{}});
  if (result.identity !== identity) throw new Error('Saved AI routing configuration failed identity verification');
  return result;
}
module.exports = {readSelection,selectionFrom,createExecutor,rememberSelection,readSavedSelection};
