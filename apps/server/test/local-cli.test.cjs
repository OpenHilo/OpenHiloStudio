const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { initializeLocalHome } = require('@openhilo/server/local-initialize');
const configuration = { format: 'intentorch.deployment', version: 1, core: { legacyFields: {} }, domain: { selection: { id: 'generic', version: 1 }, applications: {} }, ai: { execution: { adapter: 'fixture' }, implementations: {} }, legacy: {} };
function fixture(t, delayed = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-cli-'))), home = path.join(root, 'data');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); initializeLocalHome({ home, configuration });
  const composition = path.join(root, 'composition.cjs'), guard = path.join(root, 'guard.cjs');
  fs.writeFileSync(composition, `exports.createDeploymentOptions = async ({home}) => {
    console.log('factory-entered');
    ${delayed ? "await new Promise(resolve => setTimeout(resolve, 300));" : ''}
    return {
      aiExecutor: { id: 'fixture', capabilities: [], start() { throw new Error('AI forbidden in this test'); } },
      launch() { throw new Error('Worker not requested'); },
      clock: { validate: () => true, schedule() { return { stop() {} }; } },
      configuration: { read: () => ({implementation:'fixture'}), update: input => input },
    };
  };`);
  fs.writeFileSync(guard, `const Module=require('node:module'),load=Module._load;Module._load=function(id,...args){if(/ai-sdk|ai-claude|@intentorch|anthropic|^openai$|node-pty/.test(id))throw new Error('Unexpected implementation');return load.call(this,id,...args)};global.fetch=()=>{throw new Error('Unexpected outbound fetch')};`);
  return { root, home, composition, guard };
}
function launch(t, fixture, extras = []) {
  const child = spawn(process.execPath, ['--require', fixture.guard, require.resolve('@openhilo/server/local-cli'), 'start', '--home', fixture.home, '--composition', fixture.composition, ...extras], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', exited = false;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  const wait = async predicate => {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      const result = predicate(output); if (result) return result;
      if (exited) throw new Error(`CLI exited before expected output: ${output}\n${errors}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`CLI output timed out: ${output}\n${errors}`);
  };
  t.after(async () => { if (!exited) { child.kill('SIGTERM'); const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1000); await done; clearTimeout(timer); } });
  return { child, done, wait, output: () => output, errors: () => errors,
    ready: () => wait(text => text.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.status === 'listening' ? [value] : []; } catch { return []; } })[0]),
  };
}
test('CLI serves generic APIs and Studio on loopback, persists data, and exits cleanly on SIGTERM', { timeout: 10000 }, async t => {
  const f = fixture(t), studio = path.join(f.root, 'studio'); fs.mkdirSync(studio); fs.writeFileSync(path.join(studio, 'index.html'), '<main>Local Studio fixture</main>');
  const running = launch(t, f, ['--port', '0', '--studio', studio]);
  const ready = await running.ready(); assert.match(ready.address, /^http:\/\/127\.0\.0\.1:/);
  assert.deepEqual(await (await fetch(ready.address + '/api/config')).json(), { implementation: 'fixture' });
  assert.deepEqual(await (await fetch(ready.address + '/api/tag-definitions')).json(), []);
  assert.match(await (await fetch(ready.address + '/')).text(), /Local Studio fixture/);
  const created = await fetch(ready.address + '/api/classes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Document', desc: 'persisted', schema: {}, tags: {} }) });
  assert.equal(created.status, 201);
  running.child.kill('SIGTERM'); assert.deepEqual(await running.done, { code: 0, signal: null });
  assert.ok(fs.existsSync(path.join(f.home, 'entities.db')));
  const reopened = launch(t, f, ['--port', '0']); const second = await reopened.ready();
  const classes = await (await fetch(second.address + '/api/classes')).json();
  assert.ok(classes.some(item => item.name === 'Document'));
  reopened.child.kill('SIGTERM'); assert.deepEqual(await reopened.done, { code: 0, signal: null });
});
test('signal during async composition prevents listening and implicit store construction', { timeout: 10000 }, async t => {
  const f = fixture(t, true), running = launch(t, f, ['--port', '0']);
  await running.wait(text => text.includes('factory-entered')); running.child.kill('SIGTERM');
  assert.deepEqual(await running.done, { code: 0, signal: null });
  assert.equal(running.output().includes('listening'), false);
  assert.equal(fs.existsSync(path.join(f.home, 'entities.db')), false);
});
test('listen failure exits with an error after cleanup, and invalid ports fail before loading composition', { timeout: 10000 }, async t => {
  const f = fixture(t), blocker = net.createServer();
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const busy = launch(t, f, ['--port', String(blocker.address().port)]);
  assert.deepEqual(await busy.done, { code: 1, signal: null }); assert.match(busy.errors(), /EADDRINUSE/); assert.equal(busy.output().includes('listening'), false);
  const invalid = launch(t, f, ['--port', '65536']);
  assert.deepEqual(await invalid.done, { code: 1, signal: null }); assert.equal(invalid.output().includes('factory-entered'), false);
});
