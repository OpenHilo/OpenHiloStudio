import {buildExecutionPath} from '../execution-path';
import type {CFGNode,LogEvent} from '../trace-layout';
const p=(id:string,run:string,type='call',frame='root',executor='code'):LogEvent=>({event:'node_pending',node_id:id,node_run_id:run,node_type:type,frame_id:frame,executor,ts:1});
const s=(run:string,outputs:unknown={}):LogEvent=>({event:'node_success',node_run_id:run,outputs,ts:2});
test('false is explicit even when both alternatives share a target; never draws an unexecuted call as taken',()=>{
 const nodes:Record<string,CFGNode>={choice:{id:'choice',type:'if',next_true:'same',next_false:'same'},same:{id:'same',type:'call',executor:'code'}};
 const path=buildExecutionPath(nodes,[p('choice','c','if'),s('c',{condition_result:false}),p('same','a'),s('a'),{event:'run_complete'}]);
 expect(path.steps[0].decision).toBe(false); expect(path.steps[0].alternative).toBe('True · not taken'); expect(path.terminal).toBe('completed');
 const unknown=buildExecutionPath(nodes,[p('choice','c','if'),s('c'),p('same','a'),s('a')]);
 expect(unknown.steps[0].decision).toBeUndefined(); expect(unknown.steps[0].alternative).toBeUndefined(); expect(unknown.terminal).toBeUndefined();
});
test('loop body entries and final false check are distinct; child IDs cannot affect them',()=>{
 const nodes:Record<string,CFGNode>={loop:{id:'loop',type:'for',next_body:'work',next_exit:'END'},work:{id:'work',type:'call'}};
 const path=buildExecutionPath(nodes,[p('loop','l1','for'),s('l1',{condition_result:true}),p('work','w1'),s('w1'),p('loop','l2','for'),s('l2',{condition_result:true}),p('work','w2'),s('w2'),p('loop','lx','for','child'),s('lx',{condition_result:true}),p('loop','l3','for'),s('l3',{condition_result:false}),{event:'run_complete'}]);
 expect(path.steps.filter(x=>x.iteration).map(x=>x.iteration)).toEqual([1,2]);
 expect(path.steps.filter(x=>x.row.nodeId==='work').map(x=>x.row.nodeRunId)).toEqual(['w1','w2']);
 expect(path.steps.at(-1)?.exit).toBe(true); expect(path.loops[0].entries).toBe(2);
});
test('continue-inline enters another iteration without inventing a node artifact',()=>{
 const nodes={loop:{id:'loop',type:'for',next_body:'work',next_exit:'END'},work:{id:'work',type:'call'}};
 const path=buildExecutionPath(nodes,[p('loop','l1','for'),s('l1',{condition_result:true}),p('work','w1'),s('w1'),{event:'continue_inline',loop_node_id:'loop',trigger_node_run_id:'w1',condition_result:true},p('work','w2'),s('w2'),{event:'continue_inline',loop_node_id:'loop',trigger_node_run_id:'w2',condition_result:false}]);
 expect(path.steps.filter(x=>x.iteration).map(x=>x.iteration)).toEqual([1,2]);
 expect(path.steps.find(x=>x.row.key.startsWith('inline:'))?.row.nodeRunId).toBeUndefined();
 expect(path.steps.at(-1)?.exit).toBe(true);
});
test('human waiting and resume is one occurrence with the completed artifact; next round remains separate',()=>{
 const history=[{nodeRunId:'h1',attemptNodeRunIds:['h1','h2'],taskId:'t1',nodeId:'ask',frameId:'root',prompt:'Choose',resolvedInputs:{},outputTypes:[],result:{ok:false},startedAt:new Date(1000).toISOString(),completedAt:new Date(2000).toISOString(),status:'completed' as const}];
 const path=buildExecutionPath({ask:{id:'ask',type:'call',executor:'human'}},[p('ask','h1','call','root','human'),{event:'node_suspended',node_run_id:'h1'},p('ask','h2','call','root','human'),s('h2',{ok:false}),p('ask','h3','call','root','human')],history);
 expect(path.steps).toHaveLength(2);expect(path.steps[0].row.nodeRunId).toBe('h2');expect(path.steps[1].row.nodeRunId).toBe('h3');
});


test('nested loop break resets only the inner iteration counter on re-entry',()=>{
 const nodes={outer:{id:'outer',type:'for',next_body:'inner',next_exit:'END'},inner:{id:'inner',type:'while',next_body:'leave',next_exit:'outer'},leave:{id:'leave',type:'assign',next:'BREAK'}};
 const events=[p('outer','o1','for'),s('o1',{condition_result:true}),p('inner','i1','while'),s('i1',{condition_result:true}),p('leave','b1','assign'),s('b1'),p('outer','o2','for'),s('o2',{condition_result:true}),p('inner','i2','while'),s('i2',{condition_result:true}),p('inner','ix','while'),s('ix',{condition_result:false}),p('outer','ox','for'),s('ox',{condition_result:false})];
 const path=buildExecutionPath(nodes,events);
 expect(path.steps.filter(x=>x.iteration).map(x=>[x.row.nodeId,x.iteration])).toEqual([['outer',1],['inner',1],['outer',2],['inner',1]]);
 expect(path.steps.find(x=>x.transfer)?.transfer).toBe('Break');
 expect(path.loops.map(x=>x.entries)).toEqual([2,2]);
});
