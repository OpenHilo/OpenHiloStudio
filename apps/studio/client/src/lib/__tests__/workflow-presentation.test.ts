import {projectWorkflow,filterWorkflowMetadata} from '../workflow-presentation';
import type {CFGNode} from '../trace-layout';
const nodes:Record<string,CFGNode>={a:{id:'a',type:'call',executor:'ai',next:'copy'},copy:{id:'copy',type:'assign',next:'branch'},branch:{id:'branch',type:'if',next_true:'x',next_false:'y'},x:{id:'x',type:'assign',next:'finish'},y:{id:'y',type:'call',executor:'human',next:'finish'},finish:{id:'finish',type:'assign',next:'END'}};
test('contracts only linear internal nodes and retains branch alternatives and end',()=>{
 const p=projectWorkflow(nodes,'a',[],'workflow');expect(p.nodes.a.next).toBe('branch');expect(p.nodes.branch.next_false).toBe('y');expect(p.nodes.branch.next_true).toBe('END');expect(p.nodes.y.next).toBe('END');expect(p.hiddenNodeIds).toEqual(expect.arrayContaining(['copy','x','finish']));expect(nodes.a.next).toBe('copy');
});
test('keeps a failing internal node visible',()=>{
 const p=projectWorkflow(nodes,'a',[{event:'node_pending',node_id:'copy',node_run_id:'r'},{event:'node_failed',node_run_id:'r'}],'workflow');expect(p.nodes.copy).toBeDefined();
});
test('does not erase a computation-only workflow or an internal cycle',()=>{
 const ns={a:{id:'a',type:'assign',next:'b'},b:{id:'b',type:'assign',next:'a'}};const p=projectWorkflow(ns,'a',[],'workflow');expect(p.nodes[p.entry]).toBeDefined();expect(Object.keys(p.nodes).length).toBeGreaterThan(0);
});
test('preserves loops and their body edge after contracting assignments',()=>{
 const ns={loop:{id:'loop',type:'for',next_body:'copy',next_exit:'END'},copy:{id:'copy',type:'assign',next:'work'},work:{id:'work',type:'call',executor:'code',next:'loop'}};const p=projectWorkflow(ns,'loop',[],'workflow');expect(p.nodes.loop.next_body).toBe('work');expect(p.nodes.work.next).toBe('loop');
});
test('technical view preserves every node',()=>{expect(projectWorkflow(nodes,'a',[],'technical').nodes).toEqual(nodes)});

test('keeps an active internal step visible and removes it only after success',()=>{
 const pending={event:'node_pending',node_id:'copy',node_run_id:'r',frame_id:'root'};
 expect(projectWorkflow(nodes,'a',[pending],'workflow').nodes.copy).toBeDefined();
 expect(projectWorkflow(nodes,'a',[pending,{event:'node_success',node_run_id:'r'}],'workflow').nodes.copy).toBeUndefined();
});

test('metadata filters combine facet and tags without hiding unclassified records by default',()=>{
 const rows=[{name:'a',facet:'draft',tags:{team:'one'}},{name:'b',facet:'unrecognized',tags:{team:'two'}},{name:'c'}];
 expect(filterWorkflowMetadata(rows,'',{})).toEqual(rows);
 expect(filterWorkflowMetadata(rows,'draft',{team:'two'})).toEqual([]);
 expect(filterWorkflowMetadata(rows,'draft',{team:'one'})).toEqual([rows[0]]);
 expect(filterWorkflowMetadata(rows,'unrecognized',{})).toEqual([rows[1]]);
});
