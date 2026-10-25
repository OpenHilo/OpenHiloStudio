import {buildWorkflowLayout} from '../workflow-layout';
test('shows both alternatives, loop body, back edge and end without claiming a path was taken',()=>{
 const nodes={loop:{id:'loop',type:'while',next_body:'review',next_exit:'END'},review:{id:'review',type:'call',executor:'human',next:'decision'},decision:{id:'decision',type:'if',next_true:'END',next_false:'loop'}};
 const graph=buildWorkflowLayout(nodes,'loop',[]);
 expect(graph.items.map(x=>x.id)).toEqual(expect.arrayContaining(['loop','review','decision']));
 expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({from:'loop',to:'review',kind:'next_body'}),expect.objectContaining({from:'decision',to:'loop',kind:'next_false'})]));
 expect(graph.items.some(x=>x.cfg.type==='end')).toBe(true);
 expect(graph.edges.every(x=>!x.dimmed)).toBe(true);
 expect(graph.items.every(x=>Number.isFinite(x.x)&&Number.isFinite(x.y))).toBe(true);
});
test('repeated steps show latest invocation while all invocations remain available in activity',()=>{
 const events=[{event:'node_pending',node_id:'a',node_run_id:'first',frame_id:'root',node_type:'call'},{event:'node_success',node_run_id:'first'},{event:'node_pending',node_id:'a',node_run_id:'second',frame_id:'root',node_type:'call'},{event:'node_failed',node_run_id:'second',error:'Bad'},{event:'node_pending',node_id:'a',node_run_id:'child',frame_id:'child',node_type:'call'},{event:'node_success',node_run_id:'child'}];
 const graph=buildWorkflowLayout({a:{id:'a',type:'call',next:'END'}},'a',events);
 expect(graph.items.find(x=>x.id==='a')).toMatchObject({nodeRunId:'second',status:'failed',error:'Bad'});
});

test('technical view retains completed assignment status',()=>{
 const graph=buildWorkflowLayout({a:{id:'a',type:'assign',next:'b'},b:{id:'b',type:'call',next:'END'}},'a',[{event:'node_pending',node_id:'a',node_run_id:'r',node_type:'assign'},{event:'node_success',node_run_id:'r'},{event:'node_pending',node_id:'b',node_run_id:'s',node_type:'call'},{event:'node_success',node_run_id:'s'}],true);
 expect(graph.items.find(x=>x.id==='a')).toMatchObject({status:'completed',nodeRunId:'r'});
});
test('resolves nested break and continue to their own enclosing loop',()=>{
 const nodes={outer:{id:'outer',type:'for',next_body:'inner',next_exit:'END'},inner:{id:'inner',type:'for',next_body:'innerChoice',next_exit:'outerChoice'},innerChoice:{id:'innerChoice',type:'if',next_true:'BREAK',next_false:'CONTINUE'},outerChoice:{id:'outerChoice',type:'if',next_true:'BREAK',next_false:'CONTINUE'}};
 const graph=buildWorkflowLayout(nodes,'outer',[]);
 expect(graph.edges).toEqual(expect.arrayContaining([
  expect.objectContaining({from:'innerChoice',to:'outerChoice',kind:'next_true'}),
  expect.objectContaining({from:'innerChoice',to:'inner',kind:'next_false'}),
  expect.objectContaining({from:'outerChoice',to:'outer',kind:'next_false'}),
 ]));
 const end=graph.items.find(item=>item.cfg.type==='end')!;
 expect(graph.edges).toContainEqual(expect.objectContaining({from:'outerChoice',to:end.id,kind:'next_true'}));
});
