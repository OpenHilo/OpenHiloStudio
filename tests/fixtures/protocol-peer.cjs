#!/usr/bin/env node
// Protocol peer only: never calls a model or reads personal credentials.
// Alternate version metadata ensures consumers do not reinstate a version allowlist.
const readline = require('node:readline');
const fs = require('node:fs');
const send = x => process.stdout.write(JSON.stringify(x)+'\n');
const reply = (id,result) => send({id,result});
const note = (method,params) => send({method,params});
const threadId='fixture-thread', turnId='fixture-turn';
let scenario, tools, threadRequest, resumed=false;
function finish(outputs={answer:'ok', data:{nested:[1,true]}}) {
 note('item/completed',{threadId,turnId,item:{id:'msg',type:'agentMessage',phase:'final_answer',text:JSON.stringify({resultJson:JSON.stringify(outputs)})}});
 note('thread/tokenUsage/updated',{threadId,turnId,tokenUsage:{last:{inputTokens:7,outputTokens:3},total:{inputTokens:70,outputTokens:30}}});
 note('turn/completed',{threadId,turn:{id:turnId,status:'completed',items:[],error:null}});
}
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')return reply(m.id,{userAgent:'codex/0.161.0',codexHome:'/fixture',platformFamily:'unix',platformOs:'macos'});
 if(m.method==='initialized')return;
 if(m.method==='thread/start'||m.method==='thread/resume'){
  threadRequest={method:m.method,developerInstructions:m.params.developerInstructions};
  if(m.params.approvalPolicy!=='never'||!['read-only','workspace-write'].includes(m.params.sandbox))return reply(m.id,{});
  resumed=m.method==='thread/resume';
  tools=m.params.dynamicTools;
  if(m.method==='thread/start'&&(!tools||tools.some(t=>t.type!=='function')))return reply(m.id,{});
  return reply(m.id,{thread:{id:threadId,turns:[]}});
 }
 if(m.method==='turn/start'){
  const task=JSON.parse(m.params.input[0].text); scenario=task.instruction;
  note('turn/started',{threadId,turn:{id:turnId,status:'inProgress',items:[]}});
  reply(m.id,{turn:{id:turnId,status:'inProgress',items:[]}});
  if(task.output.entries){
   const breakFirst = task.instruction.includes('trigger compiler repair') && !fs.existsSync('codex/report.ts');
   if(fs.existsSync('codex/report.ts') && fs.readFileSync('codex/report.ts','utf8')==='export async function report( {' && !resumed) return process.exit(5);
   fs.mkdirSync('codex',{recursive:true});
   fs.writeFileSync('codex/report.ts', `
     declare function summarize_by_ai(role: string, prompt: string): Promise<{ answer: string }>;
     declare function write_by_code(lang: 'bash', script: string, inputs: { content: string }): Promise<{}>;
     /** @entry */
     export async function report(): Promise<{ answer: string }> {
       const { answer } = await summarize_by_ai('writer', 'ok');
       await write_by_code('bash', 'printf "%s" "$content" > report.txt', { content: answer });
       return { answer };
     }
   `);
   if(breakFirst)fs.writeFileSync('codex/report.ts','export async function report( {');
   return finish({entries:['codex/report']});
  }
  if(scenario==='native-tools'){
   const command={id:'native-command',type:'commandExecution',status:'inProgress',command:'echo test',cwd:process.cwd(),commandActions:[]};
   const change={id:'native-files',type:'fileChange',status:'inProgress',changes:[]};
   note('item/started',{threadId,turnId:'other-turn',item:{...command,id:'foreign'}});
   note('item/started',{threadId,turnId,item:command});
   note('item/started',{threadId,turnId,item:command});
   note('item/started',{threadId,turnId,item:change});
   setTimeout(()=>{
    note('item/completed',{threadId,turnId,item:{...command,status:'completed',exitCode:0}});
    note('item/completed',{threadId,turnId,item:{...command,status:'completed',exitCode:0}});
    note('item/completed',{threadId,turnId,item:{...change,status:'failed'}});
    finish();
   },40);
   return;
  }
  if(scenario==='hang')return;
  if(scenario==='tool-recovery')return send({id:'tool-failure',method:'item/tool/call',params:{threadId,turnId,callId:'call1',tool:'openhilo_tool_0',arguments:{value:'x'}}});
  if(scenario==='protocol-failure-active-tool'||scenario==='model-failure-active-tool'){
   fs.writeFileSync('peer.pid',String(process.pid));
   send({id:'held-tool',method:'item/tool/call',params:{threadId,turnId,callId:'held',tool:'openhilo_tool_0',arguments:{value:'x'}}});
   if(scenario==='protocol-failure-active-tool')process.stdout.write('invalid protocol\n');
   else note('turn/completed',{threadId,turn:{id:turnId,status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}}});
   return;
  }
  if(scenario==='crash')return process.exit(0);
  if(scenario==='bad-json'){ note('item/completed',{threadId,turnId,item:{id:'msg',type:'agentMessage',phase:'final_answer',text:'plain text'}});return note('turn/completed',{threadId,turn:{id:turnId,status:'completed',items:[]}}); }
  if(scenario==='failed'||scenario==='auth')return note('turn/completed',{threadId,turn:{id:turnId,status:'failed',items:[],error:{message:'quota exceeded',codexErrorInfo:scenario==='auth'?'unauthorized':'usageLimitExceeded'}}});
  if(scenario==='crash-tool'){setTimeout(()=>process.exit(0),30);scenario='tools';}
  if(scenario==='tools')return send({id:'tool1',method:'item/tool/call',params:{threadId,turnId,callId:'call1',namespace:null,tool:'openhilo_tool_0',arguments:{value:'x'}}});
  if(scenario==='question')return send({id:'ask1',method:'item/tool/call',params:{threadId,turnId,callId:'qcall',namespace:null,tool:'openhilo_ask_user',arguments:{prompt:'Choose a name'}}});
  if(scenario==='approval')return send({id:'approval1',method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'cmd'}});
  if(scenario==='wrong-thread'){
   send({id:'evil',method:'item/tool/call',params:{threadId:'other',turnId,callId:'bad',tool:'openhilo_tool_0',arguments:{value:'x'}}});return;
  }
  if(scenario==='wrong-kind')return finish({answer:42});
  return finish();
 }
 if(m.method==='turn/interrupt') { reply(m.id,{}); return note('turn/completed',{threadId,turn:{id:turnId,status:'interrupted',items:[]}}); }
 if(m.id==='tool-failure')return send({id:'tool-followup',method:'item/tool/call',params:{threadId,turnId,callId:'call2',tool:'openhilo_tool_0',arguments:{value:'retry'}}});
 if(m.id==='tool-followup')return finish({answer:'continued after failure'});
 if(m.id==='tool1')return finish({answer:JSON.parse(m.result.contentItems[0].text).echo});
 if(m.id==='ask1')return finish({answer:JSON.parse(m.result.contentItems[0].text)});
 if(m.id==='approval1')return finish({answer:m.result.decision});
 if(m.id==='evil')return finish({answer:m.error?'rejected':'unsafe'});
});
