const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const { initializeLocalHome } = require('@openhilo/server/local-initialize');
const { createLocalDeployment } = require('@openhilo/server/local-deployment');
const example = path.resolve(path.dirname(require.resolve('@openhilo/server')), '../examples/sdk-local');
const { readSelection, createExecutor } = require(path.join(example, 'config.cjs'));
const { createDeploymentOptions } = require(path.join(example, 'composition.cjs'));
const source = `
declare function summarize_by_ai(role: string, prompt: string): Promise<{ summary: string }>;
declare function approve_by_human(prompt: string, summary: string): Promise<{ approved: boolean }>;
declare function write_by_code(lang: 'bash', script: string, inputs: { content: string }): Promise<{}>;
/** @entry */
export async function report(): Promise<{ approved: boolean }> {
  await createEntity_by_sys('Document', 'sdk-report', {}, 'SDK report', {});
  const { summary } = await summarize_by_ai('writer', 'Prepare a report');
  const { approved } = await approve_by_human('Approve?', summary);
  if (approved) await write_by_code('bash', ${JSON.stringify('printf \'%s\\n\' "$content" >> report.txt')}, { content: summary });
  return { approved };
}`;
const wait = async read => {
  for (let i = 0; i < 700; i++) { const result = await read(); if (result) return result; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('SDK preset operation did not settle');
};
function configuration(provider, baseURL) {
  const config = JSON.parse(fs.readFileSync(path.join(example, 'config.example.json'), 'utf8'));
  config.ai.execution.profiles.general = { provider, model: 'fixture-model', api_key_env: 'INTENTORCH_PRESET_TEST_KEY', base_url: baseURL };
  return config;
}
function fixture(t, config) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-local-'))), home = path.join(root, 'data');
  initializeLocalHome({ home, configuration: config });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home };
}
function nativeResponse(provider, calls) {
  if (provider === 'openai') return { id: 'fixture-response', object: 'response', model: 'fixture-model', status: 'completed',
    output: calls.map(([id, name, args]) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' })),
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
  return { id: 'fixture-message', type: 'message', role: 'assistant', model: 'fixture-model', stop_reason: 'tool_use', stop_sequence: null,
    content: calls.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })), usage: { input_tokens: 3, output_tokens: 2 } };
}

for (const provider of ['openai', 'anthropic']) test(`${provider} SDK preset generates, publishes, runs and resumes through real workers, then launches a real cron tick`, { timeout: 25000 }, async t => {
  const requests = [], failures = [];
  const model = http.createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); requests.push(body);
      assert.equal(body.model, 'fixture-model');
      assert.equal(req.url, provider === 'openai' ? '/v1/responses' : '/v1/messages');
      const finish = body.tools.find(tool => tool.name === 'finish_task');
      const generating = (finish.parameters ?? finish.input_schema).properties.entries;
      const history = JSON.stringify(body.input ?? body.messages);
      let calls;
      if (generating) calls = history.includes('gen-write') ? [['gen-finish', 'finish_task', { entries: ['sdk/report'] }]] : [
        ['gen-class', 'define_class', { className: 'Document', schema: {}, desc: 'SDK report', tags: {} }],
        ['gen-write', 'workspace_write', { path: 'sdk/report.ts', content: source }],
      ];
      else if (history.includes('run-ask')) {
        assert.match(history, /Concise/);
        calls = [['run-finish', 'finish_task', { summary: 'Concise SDK report' }]];
      } else if (history.includes('run-query')) {
        assert.match(history, /Document/);
        calls = [['run-ask', 'ask_user', { prompt: 'Which style?', answer: 'text' }]];
      } else calls = [['run-query', 'queryClasses', {}]];
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(nativeResponse(provider, calls)));
    } catch (error) { failures.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const config = configuration(provider, `http://127.0.0.1:${model.address().port}${provider === 'openai' ? '/v1' : ''}`), f = fixture(t, config);
  const previous = process.env.INTENTORCH_PRESET_TEST_KEY;
  const previousTimers = require('node-cron').getTasks().size;
  process.env.INTENTORCH_PRESET_TEST_KEY = 'offline-only-test-key';
  let host;
  const open = async () => createLocalDeployment({ home: f.home, ...createDeploymentOptions({ home: f.home }), generation: { poolSize: 1 } });
  const request = async (method, url, payload, status = 200) => {
    const response = await host.app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, status, response.body); return response.body ? response.json() : undefined;
  };
  try {
    host = await open();
    assert.deepEqual(await request('GET', '/api/tag-definitions'), []);
    const publicConfig = await request('GET', '/api/config');
    assert.equal(JSON.stringify(publicConfig).includes('offline-only-test-key'), false);
    assert.equal(publicConfig.application.id, 'generic');
    await request('PUT', '/api/config', { ai_execution: {} }, 400);
    const generated = await request('POST', '/api/translate/start', { naturalLanguage: 'Create a report with approval' });
    assert.equal(generated.step.phase, 'cc_running', JSON.stringify(generated));
    const review = await wait(async () => {
      const step = await request('GET', `/api/translate/${generated.sessionId}`);
      return step.phase === 'cc_running' || step.phase === 'auto_fixing' ? null : step;
    });
    assert.equal(review.phase, 'confirm_merge', JSON.stringify(review));
    await host.close();
    const changedConfig = structuredClone(config);
    changedConfig.ai.execution.profiles.general.model = 'changed-model';
    fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(changedConfig));
    host = await open();
    const beforeRejectedReview = requests.length;
    await request('POST', `/api/translate/${generated.sessionId}/respond`, { type: 'merge_approve', reviewId: review.reviewId }, 500);
    assert.equal(requests.length, beforeRejectedReview);
    await host.close();
    fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config));
    host = await open();
    const beforeApproval = requests.length;
    const refreshed = await request('POST', `/api/translate/${generated.sessionId}/respond`, { type: 'merge_approve', reviewId: review.reviewId });
    assert.equal(refreshed.phase, 'confirm_merge'); assert.notEqual(refreshed.reviewId, review.reviewId);
    assert.equal(fs.existsSync(path.join(f.home, 'intents/sdk/report/report.itt.impl.json')), false);
    assert.equal((await request('POST', `/api/translate/${generated.sessionId}/respond`, { type: 'merge_approve', reviewId: refreshed.reviewId })).phase, 'done');
    assert.equal(requests.length, beforeApproval, 'review restart cannot invoke a new model task');
    const workdir = path.join(f.home, 'workspaces', 'manual');
    const { runId } = await request('POST', '/api/runs', { ittPath: 'sdk/report/report.itt.impl.json', workdir, inputs: {} }, 201);
    const question = await wait(async () => (await request('GET', `/api/runs/${runId}/ai-questions`)).find(q => q.available));
    await request('POST', `/api/runs/${runId}/ai-questions/answer`, { key: { taskId: question.taskId, attemptId: question.attemptId, questionId: question.questionId }, value: 'Concise' });
    await wait(() => !host.workers.isActive(runId));
    assert.equal((await request('GET', `/api/runs/${runId}`)).status, 'suspended');
    await host.close(); host = await open();
    const human = await request('GET', `/api/runs/${runId}/human-node`);
    const beforeResume = requests.length;
    await request('POST', `/api/runs/${runId}/resume`, { humanNodeRunId: human.nodeRunId, humanOutput: { approved: 'true' } });
    await wait(() => !host.workers.isActive(runId));
    assert.equal((await request('GET', `/api/runs/${runId}`)).status, 'completed');
    assert.equal(requests.length, beforeResume, 'completed AI node must not replay');
    assert.equal(fs.readFileSync(path.join(workdir, 'report.txt'), 'utf8'), 'Concise SDK report\n');
    assert.equal((await request('GET', '/api/entities?className=Document')).length, 1);
    await host.startSchedules();
    const schedule = await request('POST', '/api/schedules', { name: 'Real cron fixture', cron: '* * * * * *', ittPath: 'sdk/report/report.itt.impl.json', workdir: path.join(f.home, 'workspaces', 'scheduled'), inputs: {} }, 201);
    const scheduled = await wait(async () => (await request('GET', '/api/schedules')).find(s => s.id === schedule.id && s.lastRunId));
    await request('DELETE', `/api/schedules/${schedule.id}`, undefined, 204);
    await wait(async () => (await request('GET', `/api/runs/${scheduled.lastRunId}/ai-questions`)).some(q => q.available));
    await host.close();
    assert.equal(host.workers.activeRunIds().size, 0);
    assert.equal(require('node-cron').getTasks().size, previousTimers);
    assert.deepEqual(failures, []);
  } finally {
    await host?.close(); await new Promise(resolve => model.close(resolve));
    if (previous === undefined) delete process.env.INTENTORCH_PRESET_TEST_KEY; else process.env.INTENTORCH_PRESET_TEST_KEY = previous;
  }
});

test('preset rejects missing credentials, implicit domain/provider choices and changed resume identity before model access', t => {
  const config = configuration('openai', 'http://127.0.0.1:1/v1'), f = fixture(t, config);
  const first = readSelection(f.home);
  assert.throws(() => createExecutor(first, {}), /Missing SDK credential/);
  assert.equal(createExecutor(first, { INTENTORCH_PRESET_TEST_KEY: 'first-key' }).id,
    createExecutor(first, { INTENTORCH_PRESET_TEST_KEY: 'rotated-key' }).id, 'credential values are not persisted in deployment identity');
  const saved = path.join(f.home, 'runs', 'old'); fs.mkdirSync(saved);
  fs.writeFileSync(path.join(saved, 'run.json'), JSON.stringify({ application: { id: 'generic', version: 1 }, aiExecutorId: first.identity }));
  config.ai.execution.profiles.general.model = 'changed-model';
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config));
  const changed = readSelection(f.home); assert.notEqual(first.identity, changed.identity);
  const guard = path.join(f.root, 'guard.cjs');
  fs.writeFileSync(guard, `const Module=require('node:module'),load=Module._load;Module._load=function(id,...args){if(/ai-claude|@intentorch|node-pty/.test(id))throw Error('Forbidden module');return load.call(this,id,...args)};global.fetch=()=>{throw Error('Unexpected model access')};`);
  const output = execFileSync(process.execPath, ['--require', guard, '-e', `
    const assert=require('node:assert/strict');
    const {createComposition}=require(${JSON.stringify(path.join(example, 'worker.cjs'))});
    const request={kind:'resume-worker',input:{runDir:${JSON.stringify(saved)}}};
    assert.throws(()=>createComposition(request),/selection changed/);
    process.env.INTENTORCH_SDK_IDENTITY=${JSON.stringify(changed.identity)};
    assert.throws(()=>createComposition(request),/migration/);
    console.log('identity guards passed');
  `], { encoding: 'utf8', env: { ...process.env, INTENTORCH_SDK_HOME: f.home, INTENTORCH_SDK_IDENTITY: first.identity } });
  assert.match(output, /identity guards passed/);
  config.domain.selection.id = 'unregistered-app'; fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config));
  assert.throws(() => readSelection(f.home), /generic application/);
  config.domain.selection.id = 'generic'; config.ai.execution = { adapter: 'claude-code' };
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config));
  assert.throws(() => readSelection(f.home), /explicit SDK/);
});

test('installed CLI starts the SDK composition without model access and shuts down cleanly', { timeout: 10000 }, async t => {
  const f = fixture(t, configuration('openai', 'http://127.0.0.1:1/v1'));
  const guard = path.join(f.root, 'startup-guard.cjs');
  fs.writeFileSync(guard, `const Module=require('node:module'),load=Module._load;Module._load=function(id,...args){if(/ai-claude|@intentorch|node-pty/.test(id))throw Error('Forbidden module');return load.call(this,id,...args)};global.fetch=()=>{throw Error('Model access during startup')};`);
  const child = spawn(process.execPath, ['--require', guard, require.resolve('@openhilo/server/local-cli'),
    'start', '--home', f.home, '--composition', path.join(example, 'composition.cjs'), '--port', '0'],
  { env: { ...process.env, INTENTORCH_PRESET_TEST_KEY: 'startup-only-test-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', exited = false;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  try {
    const ready = await wait(() => {
      if (exited) throw new Error(`Preset CLI exited: ${errors}`);
      return output.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.status === 'listening' ? [value] : []; } catch { return []; } })[0];
    });
    assert.match(ready.address, /^http:\/\/127\.0\.0\.1:/);
    const config = await (await fetch(ready.address + '/api/config')).json();
    assert.equal(config.ai_execution.adapter, 'sdk');
    assert.equal(JSON.stringify(config).includes('startup-only-test-key'), false);
    child.kill('SIGTERM'); assert.deepEqual(await done, { code: 0, signal: null });
  } finally {
    if (!exited) {
      child.kill('SIGTERM'); const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1000);
      await done; clearTimeout(timer);
    }
  }
});
