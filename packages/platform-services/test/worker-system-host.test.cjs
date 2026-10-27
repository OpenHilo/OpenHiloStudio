const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkerSystemHost } = require('@openhilo/platform-services/worker-system-host');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-system-host-'));
  const intentsDir = path.join(root, 'intents'), workspacesDir = path.join(root, 'workspaces');
  const entry = path.join(intentsDir, 'demo', 'report'); fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'report.itt.impl.json'), JSON.stringify({ description: 'Report', inputs: {}, outputs: { value: 'number' } }));
  const schedules = [], responses = [];
  const options = { intentsDir, workspacesDir, entityManager: { queryClasses: () => [{ name: 'Document' }] },
    scheduleService: { async list() { return schedules; }, async delete(id) { return id === 'schedule'; }, async create(input) { const item = { ...input, id: 'schedule' }; schedules.push(item); return item; } } };
  const host = new WorkerSystemHost(options);
  async function call(method, args = []) { await host.handleSystemCall({ send: message => responses.push(message) }, { type: 'sys_call', reqId: 'request', method, args }); return responses.at(-1); }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { host, call, options, root, schedules };
}

test('system host resolves workflows and allocates schedules only under configured directories', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.call('queryClasses')).result, [{ name: 'Document' }]);
  assert.equal((await f.call('queryIntents')).result[0].name, 'demo.report');
  assert.equal((await f.call('queryIntents')).result[0].relativeIttPath, 'demo/report/report.itt.impl.json');
  assert.deepEqual((await f.call('queryIntentInfo', ['demo.report'])).result.outputs, { value: 'number' });
  assert.equal((await f.call('scheduleFlexibleIntent', ['0 9 * * *', 'demo.report', {}, null])).result, 'schedule');
  assert.equal(f.schedules[0].flexible, true);
  assert.equal(f.schedules[0].ittPath, path.join('demo', 'report', 'report.itt.impl.json'));
  assert.ok(f.schedules[0].workdir.startsWith(f.options.workspacesDir + path.sep)); assert.ok(fs.existsSync(f.schedules[0].workdir));
  assert.equal((await f.call('querySchedulorInfo', ['schedule'])).result.intentName, 'demo.report');
  assert.equal((await f.call('cancelSchedulor', ['schedule'])).result, true);
});

test('system errors are returned through the protocol and relative configuration is rejected', async t => {
  const f = fixture(t);
  assert.match((await f.call('queryIntentInfo', ['missing'])).error, /not found/);
  assert.match((await f.call('notAllowed')).error, /Unknown sys method/);
  assert.throws(() => new WorkerSystemHost({ ...f.options, workspacesDir: '.' }), /explicit absolute paths/);
});

test('scheduler identities round trip into scheduleIntent and distinguish namespaces', async t => {
 const f=fixture(t);
 for(const ns of ['first','second']) {
  const dir=path.join(f.options.intentsDir,ns,'entry');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'entry.itt.impl.json'),'{}');
  await f.call('scheduleIntent',['0 9 * * *',ns+'.entry',{},null]);
 }
 const queried=(await f.call('querySchedulors')).result;
 assert.deepEqual(queried.map(x=>x.intentName),['first.entry','second.entry']);
 for(const row of queried) assert.ok(fs.existsSync(path.join(f.options.intentsDir,f.host.resolveIttPath(row.intentName))));
 f.schedules[0].ittPath=path.join(f.options.intentsDir,f.schedules[0].ittPath);
 assert.equal((await f.call('querySchedulorInfo',['schedule'])).result.intentName,'first.entry');
 const before=f.schedules.length;
 if(!queried.some(x=>x.intentName==='first.entry')) await f.call('scheduleIntent',['0 9 * * *','first.entry',{},null]);
 assert.equal(f.schedules.length,before);
});

test('qualified workflow identity survives directory aliases and removed historical sources',async t=>{
 const f=fixture(t);const {qualifiedWorkflowName}=require('@openhilo/platform-services/worker-run-path');
 const alias=path.join(f.root,'intents-alias');fs.symlinkSync(f.options.intentsDir,alias,'dir');
 const entry=path.join(alias,'demo','report','report.itt.impl.json');
 assert.equal(qualifiedWorkflowName(entry,f.options.intentsDir),'demo.report');
 assert.equal(qualifiedWorkflowName(path.join(f.options.intentsDir,'demo/report/report.itt.impl.json'),alias),'demo.report');
 f.schedules.push({id:'aliased',ittPath:entry,cron:'0 9 * * *',params:{}});
 assert.equal((await f.call('querySchedulors')).result[0].intentName,'demo.report');
 fs.rmSync(path.join(f.options.intentsDir,'demo'),{recursive:true});
 assert.equal(qualifiedWorkflowName(entry,f.options.intentsDir),'demo.report');
 assert.equal(qualifiedWorkflowName(path.join(f.root,'other','entry.itt.impl.json'),f.options.intentsDir),'entry');
});


test('direct and worker queries preserve deep module identities and reject ambiguous short names', async t => {
 const f=fixture(t);const {createSysExecutor}=require('@openhilo/platform-services/system-executor');
 for(const ns of ['a.b.c.module','other.module']){
  const dir=path.join(f.options.intentsDir,...ns.split('.'),'entry');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'entry.itt.impl.json'),JSON.stringify({description:ns,inputs:{},outputs:{value:'number'}}));
 }
 const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'leaked.itt.json'),'{}');fs.symlinkSync(outside,path.join(f.options.intentsDir,'escape'));
 const execute=createSysExecutor({mode:'direct',entityManager:f.options.entityManager,intentsDir:f.options.intentsDir});
 const direct=async(method,inputs={})=>(await execute({id:'call',type:'call',executor:'sys',callee:method,inputsFrom:{},outputsTo:{},outputs:{result:'json'},next:'END'},inputs,{caller:'executor_sys'})).outputs.result;
 const directNames=(await direct('queryIntents')).map(x=>x.name).sort();
 assert.deepEqual(directNames,(await f.host.queryIntents()).map(x=>x.name).sort());
 assert.ok(directNames.includes('a.b.c.module.entry'));assert.ok(!directNames.some(x=>x.includes('leaked')));
 for(const name of ['a.b.c.module.entry','other.module.entry']){
  assert.equal((await direct('queryIntentInfo',{intentName:name})).desc,name.slice(0,-6));
  assert.equal((await f.host.queryIntentInfo(name)).desc,name.slice(0,-6));
  assert.ok(f.host.resolveIttPath(name).endsWith('entry.itt.impl.json'));
 }
 await assert.rejects(direct('queryIntentInfo',{intentName:'entry'}),/ambiguous/i);
 await assert.rejects(f.host.queryIntentInfo('entry'),/ambiguous/i);
 await assert.rejects(direct('queryIntentInfo',{intentName:'missing.entry'}),/not found/i);
 assert.throws(()=>f.host.resolveIttPath('missing.report'),/not found/i);
});
