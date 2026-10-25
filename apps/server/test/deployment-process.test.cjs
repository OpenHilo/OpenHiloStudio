const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {startDeploymentProcess}=require('../dist/deployment-process');
const deferred=()=>{let resolve; const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
for(const phase of ['create','prepare','listen','schedules']) test(`signal during ${phase} drains startup, suppresses later stages, closes once`,async()=>{
 const signals=new EventEmitter(), gate=deferred(), entered=deferred(), calls=[];
 async function step(name){calls.push(name);if(name===phase){entered.resolve();await gate.promise;}}
 const starting=startDeploymentProcess({host:'127.0.0.1',port:0,signals,
  async create(){await step('create');return {
   beforeListen:()=>step('prepare'),app:{listen:async()=>{await step('listen');return 'fixture';}},
   startSchedules:()=>step('schedules'),close:async()=>{calls.push('close');}};},
  onListening(){calls.push('ready');},onShutdownError(error){throw error;}});
 await entered.promise;signals.emit('SIGTERM');signals.emit('SIGINT');
 assert.equal(calls.includes('close'),false,'must not close while startup still owns resources');
 gate.resolve();const running=await starting;await running.close();
 assert.deepEqual(calls,[...['create','prepare','listen','schedules'].slice(0,['create','prepare','listen','schedules'].indexOf(phase)+1),'close']);
 assert.equal(signals.listenerCount('SIGTERM'),0);assert.equal(signals.listenerCount('SIGINT'),0);
});
for(const phase of ['create','prepare','listen','schedules','ready']) test(`startup failure in ${phase} cleans ownership and listeners`,async()=>{
 const signals=new EventEmitter();let closed=0;
 const step=name=>{if(name===phase)throw Error('fixture failure');};
 await assert.rejects(startDeploymentProcess({signals,host:'127.0.0.1',port:0,
  async create(){step('create');return {beforeListen:async()=>step('prepare'),app:{listen:async()=>{step('listen');return 'fixture';}},startSchedules:async()=>step('schedules'),close:async()=>{closed++;}};},
  onListening:()=>step('ready')}),/fixture failure/);
 assert.equal(closed,phase==='create'?0:1);assert.equal(signals.listenerCount('SIGTERM'),0);
});
test('normal startup and explicit close remove listeners and preserve order',async()=>{
 const calls=[],signals=new EventEmitter();const running=await startDeploymentProcess({signals,host:'127.0.0.1',port:0,
  async create(){return {app:{listen:async opts=>{assert.deepEqual(opts,{host:'127.0.0.1',port:0});calls.push('listen');return 'fixture';}},startSchedules:async()=>{calls.push('schedules');},close:async()=>{calls.push('close');}};},
  onListening:address=>{assert.equal(address,'fixture');calls.push('ready');}});
 await Promise.all([running.close(),running.close()]);assert.deepEqual(calls,['listen','schedules','ready','close']);assert.equal(signals.listenerCount('SIGTERM'),0);
});
