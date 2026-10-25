const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseDeploymentConfig } = require('@openhilo/platform-services/deployment-config');
const { parseAiExecutionConfig } = require('@openhilo/studio-contracts/ai-config');
const { createSdkTaskExecutor } = require('@openhilo/ai-sdk');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function readSelection(home) {
  if (!home || !path.isAbsolute(home)) throw new Error('SDK deployment requires an explicit absolute home');
  home = fs.realpathSync(home);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); }
  catch { throw new Error('Could not read SDK deployment configuration'); }
  const config = parseDeploymentConfig(raw);
  const application = config.domain.selection;
  if (application.id !== 'generic' || application.version !== 1 || Object.keys(application).some(key => !['id', 'version'].includes(key)))
    throw new Error('SDK local preset requires explicit generic application version 1');
  const execution = parseAiExecutionConfig(config.ai.execution);
  if (execution?.adapter !== 'sdk') throw new Error('SDK local preset requires explicit SDK execution');
  const identity = 'intentorch.sdk-local.v1:' + createHash('sha256').update(JSON.stringify(canonical({ application, execution }))).digest('hex');
  return { home, application, execution, identity };
}
function createExecutor(selection, env = process.env) {
  const profiles = Object.fromEntries(Object.entries(selection.execution.profiles).map(([name, profile]) => {
    const apiKey = env[profile.api_key_env];
    if (!apiKey?.trim()) throw new Error(`Missing SDK credential environment variable for profile ${name}`);
    return [name, { provider: profile.provider, model: profile.model, apiKey,
      baseURL: profile.base_url, maxOutputTokens: profile.max_output_tokens }];
  }));
  return createSdkTaskExecutor(profiles, selection.execution.default_profile, { id: selection.identity, timeoutMs: selection.execution.timeout_ms });
}
module.exports = { readSelection, createExecutor };
