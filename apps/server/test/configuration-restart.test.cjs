const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeLocalHome } = require('@openhilo/server/local-initialize');

for (const adapter of ['codex', 'sdk']) test(`${adapter} preset reports saved configuration drift without changing the active selection`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configuration-restart-')), home = path.join(root, 'home');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const example = path.resolve(path.dirname(require.resolve('@openhilo/server')), `../examples/${adapter}-local`);
  const config = JSON.parse(fs.readFileSync(path.join(example, 'config.example.json'), 'utf8'));
  const marker = 'QA_FAKE_RESTART_SECRET';
  config.legacy = { privateToken: marker };
  if (adapter === 'sdk') {
    config.ai.execution.profiles.general.api_key_env = 'INTENTORCH_QA_RESTART_TEST_KEY';
    const previous = process.env.INTENTORCH_QA_RESTART_TEST_KEY;
    process.env.INTENTORCH_QA_RESTART_TEST_KEY = marker;
    t.after(() => { if (previous === undefined) delete process.env.INTENTORCH_QA_RESTART_TEST_KEY; else process.env.INTENTORCH_QA_RESTART_TEST_KEY = previous; });
  }
  initializeLocalHome({ home, configuration: config });
  const { createDeploymentOptions } = require(path.join(example, 'composition.cjs'));
  const current = createDeploymentOptions({ home }).configuration;
  const initial = await current.read();
  assert.deepEqual(initial.configuration_status, { activation: 'restart', restart_required: false, editable: false });
  if (adapter === 'codex') config.ai.execution.timeout_ms += 1;
  else config.ai.execution.profiles.general.model = 'changed-test-model';
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  for (let refresh = 0; refresh < 2; refresh++) {
    const saved = await current.read();
    assert.equal(saved.configuration_status.restart_required, true);
    assert.deepEqual(saved.ai_execution, initial.ai_execution, 'saving must not silently replace the active executor');
    assert.equal(JSON.stringify(saved).includes(marker), false);
  }
  const restarted = await createDeploymentOptions({ home }).configuration.read();
  assert.equal(restarted.configuration_status.restart_required, false);
  assert.deepEqual(restarted.ai_execution, config.ai.execution);
  fs.writeFileSync(path.join(home, 'config.json'), '{' + marker);
  assert.throws(() => current.read(), error => /Could not read/.test(error.message) && !error.message.includes(marker));
});
