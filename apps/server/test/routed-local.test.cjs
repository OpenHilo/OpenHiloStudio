const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {initializeLocalHome}=require('@openhilo/server/local-initialize');
const {buildGenericPrompt}=require('@openhilo/generation-contracts');
const example=path.resolve(__dirname,'../examples/routed-local');
function api(){assert.ok(fs.existsSync(path.join(example,'config.cjs')),'direct configuration factory exists');return require(path.join(example,'config.cjs'))}
const base=()=>({"format": "intentorch.deployment", "version": 1, "core": {"legacyFields": {}}, "domain": {"selection": {"id": "generic", "version": 1}, "applications": {}}, "ai": {"execution": {"adapter": "routed", "routes": {"default": {"defaultLevel": "medium", "levels": {"medium": {"adapter": "codex"}}}, "coding": {"defaultLevel": "pro", "levels": {"pro": {"adapter": "codex", "model": "coding-model"}}}, "search": {"defaultLevel": "light", "levels": {"light": {"adapter": "sdk", "default_profile": "main", "profiles": {"main": {"provider": "openai", "model": "search-model", "api_key_env": "SEARCH_KEY"}}}}}}}, "implementations": {}}, "legacy": {}});
test('direct host factory produces stable identity without credential values or registrations',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'route-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const home=path.join(root,'home');initializeLocalHome({home,configuration:base()});
 const {readSelection,createExecutor}=api(),s=readSelection(home);const a=createExecutor(s,{SEARCH_KEY:'secret-one'}),b=createExecutor(s,{SEARCH_KEY:'secret-two'});assert.equal(a.id,b.id);assert.ok(a.capabilities.includes('model_selection'));assert.ok(!JSON.stringify(s).includes('secret'));
 const c=base();c.ai.execution.routes.coding.levels.pro.model='other';fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(c));assert.notEqual(createExecutor(readSelection(home),{SEARCH_KEY:'secret'}).id,a.id);
 assert.throws(()=>createExecutor(s,{}),/credential|environment/i);
});
test('generation guidance uses only available routes and preserves default behavior',()=>{
 const plain=buildGenericPrompt({naturalLanguage:'Hello',round:1,maxRounds:2});assert.ok(!plain.systemPrompt.includes('@ai.type'));
 const routed=buildGenericPrompt({naturalLanguage:'Hello',round:1,maxRounds:2,aiRoutes:{default:{defaultLevel:'medium',levels:['medium']},coding:{defaultLevel:'pro',levels:['pro']}}});
 assert.match(routed.systemPrompt,/@ai.type/);assert.match(routed.systemPrompt,/@ai.level/);assert.match(routed.userMessage,/coding/);assert.match(routed.systemPrompt,/Do not invent/);assert.match(routed.systemPrompt,/omit/);
});

test('routed resume preserves its archived selection when current configuration changes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'route-resume-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),runDir=path.join(root,'run');const cfg=base();delete cfg.ai.execution.routes.search;
 initializeLocalHome({home,configuration:cfg});fs.mkdirSync(runDir);
 const {createDeploymentOptions}=require(path.join(example,'composition.cjs'));
 const opts=createDeploymentOptions({home});const selection=api().readSelection(home);
 const receipt=JSON.stringify({ai_routing_identity:opts.aiExecutor.id,aiExecutorId:selection.identity,status:'suspended'});
 fs.writeFileSync(path.join(runDir,'run.json'),receipt);
 assert.doesNotThrow(()=>opts.beforeResume({runDir}));
 cfg.ai.execution.routes.coding.levels.pro.model='changed';fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(cfg));
 assert.doesNotThrow(()=>opts.beforeResume({runDir}));
 const archive=path.join(home,'.ai-routing',selection.identity.split(':')[1]+'.json');
 const archiveBytes=fs.readFileSync(archive);fs.unlinkSync(archive);
 assert.throws(()=>opts.beforeResume({runDir}),error=>error.statusCode===400&&/original revision/.test(error.message));
 fs.writeFileSync(archive,archiveBytes);
 assert.equal(fs.readFileSync(path.join(runDir,'run.json'),'utf8'),receipt);
 cfg.ai.execution.routes.coding.levels.pro.model='coding-model';fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(cfg));
 assert.doesNotThrow(()=>opts.beforeResume({runDir}));
});

test('direct SDK cells dispatch through real OpenAI and Anthropic clients with offline transports',async t=>{
 const original=globalThis.fetch,seen=[];t.after(()=>{globalThis.fetch=original});
 globalThis.fetch=async(url,init)=>{
  const body=JSON.parse(init.body);seen.push({url:String(url),model:body.model});
  const outputs={answer:body.model};
  const data=String(url).includes('/responses')
   ? {id:'response',status:'completed',output:[{type:'function_call',call_id:'finish',name:'finish_task',arguments:JSON.stringify(outputs)}]}
   : {id:'message',type:'message',role:'assistant',stop_reason:'tool_use',content:[{type:'tool_use',id:'finish',name:'finish_task',input:outputs}],usage:{input_tokens:1,output_tokens:1}};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 const cell=(provider,model)=>({adapter:'sdk',default_profile:'only',profiles:{only:{provider,model,api_key_env:'OFFLINE_KEY'}}});
 const router=api().createExecutor({execution:{adapter:'routed',routes:{
  default:{defaultLevel:'medium',levels:{medium:cell('openai','default-fixture')}},
  coding:{defaultLevel:'pro',levels:{pro:cell('anthropic','coding-fixture')}},
 }}},{OFFLINE_KEY:'fixture-not-a-real-key'});
 for(const [aiSelection,want] of [[undefined,'default-fixture'],[{type:'coding'},'coding-fixture']]){
  const execution=await router.start({version:1,taskId:want,instruction:'Return the fixture value',inputs:{},output:{answer:'text'},requiredCapabilities:[],...(aiSelection?{aiSelection}:{})},{attemptId:want,signal:new AbortController().signal,onEvent(){}});
  const result=await execution.result;assert.equal(result.status,'completed',JSON.stringify(result));assert.deepEqual(result.outputs,{answer:want});
 }
 assert.deepEqual(seen.map(x=>x.model),['default-fixture','coding-fixture']);
 assert.match(seen[0].url,/api.openai.com\/v1\/responses/);assert.match(seen[1].url,/api.anthropic.com\/v1\/messages/);
});
