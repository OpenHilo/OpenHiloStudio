const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {initializeLocalHome}=require('@openhilo/server/local-initialize');
const {createLocalDeployment}=require('@openhilo/server/local-deployment');
const example=path.resolve(__dirname,'../examples/routed-local');
const {createDeploymentOptions}=require(path.join(example,'composition.cjs'));
const {readSelection,readSavedSelection}=require(path.join(example,'config.cjs'));
function setup(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'routed-settings-')),home=path.join(root,'home');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cfg=JSON.parse(fs.readFileSync(path.join(example,'config.example.json'),'utf8'));
 cfg.legacy={privateToken:'PRIVATE_TEST_SENTINEL'};
 initializeLocalHome({home,configuration:cfg});return {home,cfg};
}
test('route settings atomically save validated revisions, preserve private fields, reject stale edits and keep active selection',t=>{
 const {home,cfg}=setup(t), original=readSelection(home), options=createDeploymentOptions({home}), settings=options.configuration;
 const before=settings.read();assert.equal(before.configuration_status.editable,true);assert.ok(!JSON.stringify(before).includes('PRIVATE_TEST_SENTINEL'));
 const changed=structuredClone(before.ai_execution);changed.routes.default.levels.medium.model='configured-model';
 const after=settings.update({ai_execution:changed,configuration_revision:before.configuration_revision});
 assert.deepEqual(after.ai_execution,before.ai_execution);assert.deepEqual(after.saved_ai_execution,changed);assert.equal(after.configuration_status.restart_required,true);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'config.json'))).legacy,cfg.legacy);
 assert.deepEqual(readSavedSelection(home,original.identity).execution,before.ai_execution);
 const bytes=fs.readFileSync(path.join(home,'config.json'),'utf8');
 assert.throws(()=>settings.update({ai_execution:changed,configuration_revision:before.configuration_revision}),/changed since/);
 const invalid=structuredClone(changed);invalid.routes.default.defaultLevel='max';
 assert.throws(()=>settings.update({ai_execution:invalid,configuration_revision:after.configuration_revision}),/defaultLevel/);
 assert.throws(()=>settings.update({ai_execution:changed,configuration_revision:after.configuration_revision,secret:'do not save'}),/Only AI/);
 assert.equal(fs.readFileSync(path.join(home,'config.json'),'utf8'),bytes);
 assert.equal(fs.statSync(path.join(home,'config.json')).mode & 0o777,0o600);
 const restarted=createDeploymentOptions({home}).configuration.read();assert.deepEqual(restarted.ai_execution,changed);assert.equal(restarted.configuration_status.restart_required,false);
 const archive=path.join(home,'.ai-routing',original.identity.split(':')[1]+'.json');
 const raw=JSON.parse(fs.readFileSync(archive));raw.execution.routes.default.levels.medium.model='tampered';fs.writeFileSync(archive,JSON.stringify(raw));
 assert.throws(()=>readSavedSelection(home,original.identity),/identity verification/);
 assert.throws(()=>readSavedSelection(home,'../../config.json'),/Invalid saved/);
});

test('saving and activating routes preserves Human recovery and completed Code effects across restart', {timeout:20000},async t=>{
 const {home}=setup(t);let host=await createLocalDeployment({home,...createDeploymentOptions({home})});
 t.after(async()=>{await host.close();});
 const file=path.join(home,'intents/route-recovery.itt.impl.json');
 const code=(id,script,next)=>({id,type:'call',executor:'code',lang:'bash',script,inputsFrom:{},outputsTo:{},outputs:{},next});
 fs.writeFileSync(file,JSON.stringify({version:2,entry:'before',nodes:{
  before:code('before','printf "before\\n" >> effects','human'),
  human:{id:'human',type:'call',executor:'human',intent:'Approve once',inputsFrom:{},outputsTo:{approved:'approved'},outputs:{approved:'boolean'},next:'after'},
  after:code('after','printf "after\\n" >> effects','END')
 }}));
 const request=async(method,url,payload,status=200)=>{const r=await host.app.inject({method,url,payload});assert.equal(r.statusCode,status,r.body);return r.json();};
 const idle=async id=>{for(let i=0;i<500;i++){if(!host.workers.isActive(id))return request('GET','/api/runs/'+id);await new Promise(r=>setTimeout(r,10));}throw Error('Worker did not finish');};
 const start=async label=>{const workdir=path.join(home,'workspaces',label);return {...await request('POST','/api/runs',{ittPath:'route-recovery.itt.impl.json',workdir,inputs:{}},201),workdir};};
 const first=await start('original'),paused=await idle(first.runId);assert.equal(paused.status,'suspended');
 const settings=await request('GET','/api/config'),changed=structuredClone(settings.ai_execution);changed.routes.default.levels.medium.model='new-selection';
 await request('PUT','/api/config',{ai_execution:changed,configuration_revision:settings.configuration_revision});
 const pending=await start('pending');assert.equal((await idle(pending.runId)).aiExecutorId,paused.aiExecutorId,'new work stays on active selection until restart');
 await host.close();host=await createLocalDeployment({home,...createDeploymentOptions({home})});
 const active=await start('activated');assert.notEqual((await idle(active.runId)).aiExecutorId,paused.aiExecutorId);
 const human=await request('GET','/api/runs/'+first.runId+'/human-node');
 await request('POST','/api/runs/'+first.runId+'/resume',{humanNodeRunId:human.nodeRunId,humanOutput:{approved:'true'}});
 const done=await idle(first.runId);assert.equal(done.status,'completed',JSON.stringify(done.events.slice(-3)));assert.equal(done.aiExecutorId,paused.aiExecutorId);
 assert.equal(fs.readFileSync(path.join(first.workdir,'effects'),'utf8'),'before\nafter\n');
 assert.equal(done.events.filter(e=>e.event==='node_pending'&&e.node_id==='before').length,1);
 assert.equal((await request('GET','/api/runs/'+pending.runId)).status,'suspended','no automatic old-run replay');
});
