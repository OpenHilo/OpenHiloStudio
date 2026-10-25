import {executionFrames} from '../execution-frames';
import {buildExecutionPath} from '../execution-path';
import type {LogEvent} from '../trace-layout';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExecutionGraph} from '../../components/ExecutionGraph';
jest.mock('../../components/WorkflowGraph',()=>({WorkflowGraph:()=>null}));

const p=(frame:string,run:string,id:string,executor='intent',type='call'):LogEvent=>({event:'node_pending',frame_id:frame,node_run_id:run,node_id:id,node_type:type,executor,intent_name:frame==='root'?'entry':'demo.child'});
const success=(run:string,outputs:unknown={}):LogEvent=>({event:'node_success',node_run_id:run,outputs});
const push=(frame:string,callee='demo.child'):LogEvent=>({event:'frame_push',frame_id:frame,callee});
const pop=(frame:string):LogEvent=>({event:'frame_pop',frame_id:frame});
const events:LogEvent[]=[p('root','parent','call_child_1'),push('child1'),p('child1','nested','call_child_1'),push('child2'),p('child2','ai1','call_work_1','ai'),success('ai1',{value:'nested'}),pop('child2'),success('nested'),p('child1','ask1','call_ask_1','human'),{event:'node_suspended',node_run_id:'ask1'}];

test('nested and recursive calls retain parent invocation identity and propagate waiting',()=>{
 const frames=executionFrames(events);
 expect(frames.map(f=>[f.id,f.parentId,f.parentNodeRunId,f.call,f.status])).toEqual([
  ['root',undefined,undefined,1,'suspended'],['child1','root','parent',1,'suspended'],['child2','child1','nested',2,'completed'],
 ]);
 expect(frames[2].depth).toBe(2);
 const completed=executionFrames([...events,{event:'run_resume'},p('child1','ask2','call_ask_1','human'),success('ask2'),pop('child1'),success('parent'),{event:'run_complete'}]);
 expect(completed.every(f=>f.status==='completed')).toBe(true);
});

test('child frame selection shows only its invocations and never borrows root CFG metadata',()=>{
 const rootNodes={call_child_1:{id:'call_child_1',type:'call',callee:'Root-only name',executor:'intent'}};
 expect(buildExecutionPath(rootNodes,events).steps.map(s=>s.row.nodeRunId)).toEqual(['parent']);
 const path=buildExecutionPath(rootNodes,events,[],false,'child1');
 expect(path.steps.map(s=>s.row.nodeRunId)).toEqual(['nested','ask1']);
 expect(path.steps[0].row.title).not.toBe('Root-only name');
 expect(path.terminal).toBeUndefined();
 expect(buildExecutionPath(rootNodes,events,[],false,'child2').terminal).toBe('completed');
});

test('child conditions, loop re-entry and inline loop checks use recorded evidence',()=>{
 const logs=[p('root','parent','call_child_1'),push('child'),p('child','l1','loop','', 'for'),success('l1',{iteration:'first',condition_result:true}),p('child','if1','choice','','if'),success('if1',{condition_result:false}),p('child','work','work','code'),success('work'),{event:'continue_inline',trigger_node_run_id:'work',loop_node_id:'loop',condition_result:true},p('child','l2','loop','','for'),success('l2',{iteration:'first',condition_result:true}),p('child','lx','loop','','for'),success('lx',{condition_result:false}),p('child','unknown','loop','','for')];
 const path=buildExecutionPath({loop:{id:'loop',type:'call',callee:'Wrong root loop'}},logs,[],false,'child');
 expect(path.steps.filter(s=>s.iteration).map(s=>s.iteration)).toEqual([1,2,1]);
 expect(path.steps.find(s=>s.row.nodeRunId==='if1')?.decision).toBe(false);
 expect(path.steps.find(s=>s.row.nodeRunId==='lx')?.exit).toBe(true);
 expect(path.steps.at(-1)?.iteration).toBeUndefined();
 expect(path.steps.at(-1)?.exit).toBeUndefined();
});

test('child human attempts merge while repeated child calls remain separate; resumed failures are not terminal',()=>{
 const history=[{nodeRunId:'ask1',attemptNodeRunIds:['ask1','ask2'],taskId:'t',nodeId:'call_ask_1',frameId:'child1',prompt:'Choose',resolvedInputs:{},outputTypes:[],result:{ok:true},startedAt:new Date(1000).toISOString(),status:'completed' as const}];
 const resumed=[...events,{event:'run_failed'},{event:'run_resume'},p('child1','ask2','call_ask_1','human'),success('ask2'),pop('child1'),success('parent'),p('root','again','call_child_1'),push('child3'),p('child3','newAsk','call_ask_1','human')];
 const path=buildExecutionPath({},resumed,history,false,'child1');
 expect(path.steps.filter(s=>s.row.executor==='human')).toHaveLength(1);
 expect(path.steps.at(-1)?.row.nodeRunId).toBe('ask2');
 expect(buildExecutionPath({},resumed,history,false,'child3').terminal).toBeUndefined();
 expect(executionFrames(resumed).find(f=>f.id==='child3')).toMatchObject({call:3,parentNodeRunId:'again',status:'running'});
});

test('graph exposes child navigation and the deepest currently waiting workflow',()=>{
 const html=renderToStaticMarkup(createElement(ExecutionGraph,{nodes:{},entry:'call_child_1',events,history:[],onStepClick:()=>{},inspector:{onClose:()=>{}}}));
 expect(html).toContain('Workflow call');
 expect(html).toContain('View child steps · demo.child · Waiting for input');
 expect(html).toContain('Waiting for input in demo.child · View steps');
 expect(html).toContain('Saved definition');
});

test('legacy logs without frame identities retain a single path',()=>{
 const logs=[{event:'node_pending',node_run_id:'one',node_id:'work',node_type:'call',executor:'code'},success('one')];
 expect(executionFrames(logs)).toEqual([]);
 expect(buildExecutionPath({},logs).steps).toHaveLength(1);
});
