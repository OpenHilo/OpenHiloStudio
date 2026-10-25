import {buildExecutionActivity, describeNode, currentRunFailure} from '../execution-presentation';
import type {LogEvent} from '../trace-layout';
const pending=(id:string,run:string,type='call',executor='ai',frame='root'):LogEvent=>({event:'node_pending',node_id:id,node_run_id:run,frame_id:frame,node_type:type,executor,ts:1,inputs:{intent:'Write a short summary'}});
test('hides successful assignments but preserves failures and source identity',()=>{
 const events=[pending('assign_1','a','assign',''),{event:'node_success',node_run_id:'a',ts:2},pending('assign_2','b','assign',''),{event:'node_failed',node_run_id:'b',error:'Invalid value',ts:3}];
 const items=buildExecutionActivity(events); expect(items).toHaveLength(1);expect(items[0]).toMatchObject({nodeRunId:'b',status:'failed',error:'Invalid value'});expect(items[0].sourceEventIndexes).toEqual([2,3]);
});
test('same-name calls in child frames and later rounds never collapse together',()=>{
 const events=[pending('call_review_1','r1','call','human'),{event:'node_suspended',node_run_id:'r1'},pending('call_review_1','r2','call','human','child'),{event:'node_success',node_run_id:'r2'},pending('call_review_1','r3','call','human'),{event:'node_success',node_run_id:'r3'}];
 expect(buildExecutionActivity(events).map(x=>[x.nodeRunId,x.status])).toEqual([['r1','suspended'],['r2','completed'],['r3','completed']]);
});
test('keeps unknown failed events and current internal work visible',()=>{
 expect(buildExecutionActivity([{event:'node_failed',node_run_id:'lost',error:'Broken'}])[0]).toMatchObject({status:'failed',error:'Broken'});
 expect(buildExecutionActivity([pending('assign_1','r','assign','')])[0].status).toBe('running');
});
test('uses saved function names rather than compiler IDs when metadata exists',()=>{
 expect(describeNode({id:'call_summary_99',type:'call',callee:'provide_topic',executor:'human'}).title).toBe('provide_topic');
 const items=buildExecutionActivity([pending('call_summary_99','a'),{event:'node_success',node_run_id:'a',outputs:{summary:'Done'},ts:4}],{'call_summary_99':{id:'call_summary_99',type:'call',callee:'summarize',executor:'ai'}});
 expect(items[0]).toMatchObject({title:'summarize',outputs:{summary:'Done'},startedAt:1,endedAt:4});
});
test('does not apply a parent snapshot node label to same-name child nodes',()=>{
 const rows=buildExecutionActivity([pending('same','p','call','ai'),pending('same','c','call','code','child')],{same:{id:'same',type:'call',callee:'parent_function',executor:'ai'}});
 expect(rows[1].title).not.toBe('parent_function');expect(rows[1].executor).toBe('code');
});
test('branch summary uses explicit boolean result, never execution of a shared successor',()=>{
 const rows=buildExecutionActivity([pending('if_1','b','if',''),{event:'node_success',node_run_id:'b',outputs:{condition_result:false}}]);
 expect(rows[0]).toMatchObject({kind:'if',outputs:{condition_result:false}});
});

test('an unrecognized event carrying an error remains visible',()=>{
 expect(buildExecutionActivity([{event:'adapter_failure',error:'Connection lost',ts:5}])[0]).toMatchObject({status:'failed',error:'Connection lost',sourceEventIndexes:[0]});
});

test('uses readable saved conditions but keeps compiler helper expressions out of titles',()=>{
 expect(describeNode({id:'if_1',type:'if',condition:'answer.stop'}).title).toBe('If answer.stop');
 expect(describeNode({id:'if_2',type:'if',condition:'__openhilo_data_value__(answer).stop'}).title).toBe('Choose a branch');
});

test('combines only attempts belonging to the same durable human request, preserving loop rounds and frames', () => {
 const events = [pending('review','a','call','human'), {event:'node_suspended',node_run_id:'a',ts:2}, pending('review','b','call','human'), {event:'node_success',node_run_id:'b',outputs:{continue:false},ts:18}, pending('review','c','call','human'), {event:'node_suspended',node_run_id:'c',ts:20}, pending('review','d','call','human','child')];
 const history = [{taskId:'request-one',nodeRunId:'a',attemptNodeRunIds:['a','b'],nodeId:'review',frameId:'root',prompt:'Choose',resolvedInputs:{summary:'Actual input'},outputTypes:[],result:{continue:false},startedAt:new Date(1000).toISOString(),completedAt:new Date(18000).toISOString(),status:'completed' as const}];
 const rows=buildExecutionActivity(events,{},false,history);
 expect(rows).toHaveLength(3);
 expect(rows[0]).toMatchObject({status:'completed',inputs:{summary:'Actual input'},outputs:{continue:false},startedAt:1,endedAt:18,sourceEventIndexes:[0,1,2,3]});
 expect(rows[1].nodeRunId).toBe('c'); expect(rows[2].nodeRunId).toBe('d');
});

test('a delayed human-history poll cannot turn a completed event back into waiting',()=>{
 const events=[pending('review','a','call','human'),{event:'node_suspended',node_run_id:'a',ts:2},pending('review','b','call','human'),{event:'node_success',node_run_id:'b',outputs:{ok:false},ts:10}];
 const rows=buildExecutionActivity(events,{},false,[{nodeRunId:'a',taskId:'request',attemptNodeRunIds:['a','b'],nodeId:'review',frameId:'root',prompt:'Choose',resolvedInputs:{},outputTypes:[],startedAt:new Date(1000).toISOString(),status:'suspended'}]);
 expect(rows[0]).toMatchObject({status:'completed',outputs:{ok:false},endedAt:10});
});


test('accepted human answers show continuation, never another request to answer or a premature typed result',()=>{
 const events=[pending('review','a','call','human'),{event:'node_suspended',node_run_id:'a',ts:2}];
 const history=[{nodeRunId:'a',taskId:'request',nodeId:'review',frameId:'root',prompt:'Choose',resolvedInputs:{},outputTypes:[],startedAt:new Date(1000).toISOString(),status:'suspended' as const,acceptedSubmission:{taskId:'request',submissionId:'submit-one',outputs:{ok:'false'}}}];
 const rows=buildExecutionActivity(events,{},false,history);
 expect(rows[0].status).toBe('resuming'); expect(rows[0].outputs).toBeUndefined();
 expect(buildExecutionActivity([...events,{event:'node_success',node_run_id:'a',outputs:{ok:false},ts:4}],{},false,history)[0].status).toBe('completed');
});

test('resuming or completing clears the run alert while preserving each failed attempt',()=>{
 const first:LogEvent={event:'run_failed',reason:'First failure'};
 const second:LogEvent={event:'run_failed',reason:'Second failure'};
 expect(currentRunFailure([first,{event:'suspended_state'}])).toBe(first);
 expect(currentRunFailure([first,{event:'run_resume'}])).toBeUndefined();
 expect(currentRunFailure([first,{event:'run_resume'},second])).toBe(second);
 expect(currentRunFailure([first,{event:'run_resume'},second,{event:'run_resume'},{event:'run_complete'}])).toBeUndefined();
 const rows=buildExecutionActivity([pending('code','c1','call','code'),{event:'node_failed',node_run_id:'c1',error:'First failure'},first,{event:'run_resume'},pending('code','c2','call','code'),{event:'node_success',node_run_id:'c2'},{event:'run_complete'}]);
 expect(rows.map(row=>row.status)).toEqual(['failed','completed']);
});


test('a durable user stop closes waiting calls and preserves completed steps', () => {
  const events = [
    {event:'node_pending', ts:1, node_run_id:'done', node_id:'first', frame_id:'root', node_type:'call', executor:'code'},
    {event:'node_success', ts:2, node_run_id:'done', outputs:{value:1}},
    {event:'node_pending', ts:3, node_run_id:'wait', node_id:'ask', frame_id:'root', node_type:'call', executor:'human'},
    {event:'node_suspended', ts:4, node_run_id:'wait'},
    {event:'run_abort', ts:5},
  ];
  const rows = buildExecutionActivity(events);
  expect(rows.map(row=>row.status)).toEqual(['completed','aborted']);
  expect(rows[0].outputs).toEqual({value:1});
  expect(rows[1].endedAt).toBe(5);
});
