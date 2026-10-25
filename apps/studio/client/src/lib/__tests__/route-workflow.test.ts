import {buildWorkflowLayout} from '../workflow-layout';
import {routeWorkflow} from '../route-workflow';
import type {CFGNode} from '../trace-layout';
const cases:Record<string,Record<string,CFGNode>>={
  'loop with continue and false branch':{loop:{id:'loop',type:'for_each',next_body:'human',next_exit:'END'},human:{id:'human',type:'call',executor:'human',next:'choice'},choice:{id:'choice',type:'if',next_true:'CONTINUE',next_false:'ai'},ai:{id:'ai',type:'call',executor:'ai',next:'code'},code:{id:'code',type:'call',executor:'code',next:'loop'}},
  'nested break and continue':{loop:{id:'loop',type:'for',next_body:'inner',next_exit:'END'},inner:{id:'inner',type:'while',next_body:'choice',next_exit:'after'},choice:{id:'choice',type:'if',next_true:'BREAK',next_false:'CONTINUE'},after:{id:'after',type:'call',next:'loop'}},
  'shared successor':{loop:{id:'loop',type:'if',next_true:'work',next_false:'work'},work:{id:'work',type:'call',next:'END'}},
};
for(const [title,nodes] of Object.entries(cases))test(title+' routes every edge without crossing node interiors',async()=>{
 const source=buildWorkflowLayout(nodes,'loop',[]);const graph=await routeWorkflow(source);
 expect(graph.edges.map(e=>[e.from,e.to,e.kind])).toEqual(source.edges.map(e=>[e.from,e.to,e.kind]));
 expect(graph.items[0].id).toBe('loop');expect(graph.items[0].y).toBe(Math.min(...graph.items.map(n=>n.y)));
 const end=graph.items.find(n=>n.cfg.type==='end')!;expect(end.y).toBe(Math.max(...graph.items.map(n=>n.y)));
 for(const node of graph.items){
  expect(node.x).toBeGreaterThanOrEqual(0);expect(node.y).toBeGreaterThanOrEqual(0);
  expect(node.x+node.w).toBeLessThanOrEqual(graph.width);expect(node.y+node.h).toBeLessThanOrEqual(graph.height);
  for(const other of graph.items)if(node!==other)expect(node.x+node.w<=other.x||other.x+other.w<=node.x||node.y+node.h<=other.y||other.y+other.h<=node.y).toBe(true);
 }
 for(const edge of graph.edges){
  expect(edge.points!.length).toBeGreaterThanOrEqual(2);
  if(edge.kind!=='next')expect(edge.label?.text).toBeTruthy();
  for(let i=1;i<edge.points!.length;i++){
   const a=edge.points![i-1],b=edge.points![i];// ELK may differ at the last floating-point bit (e.g. 240.33333333333331 vs .334).
   expect(Math.min(Math.abs(a.x-b.x),Math.abs(a.y-b.y))).toBeLessThan(1e-8);
   for(const node of graph.items){
    const crosses=Math.abs(a.x-b.x)<1e-8 ? a.x>node.x+.01&&a.x<node.x+node.w-.01&&Math.max(a.y,b.y)>node.y+.01&&Math.min(a.y,b.y)<node.y+node.h-.01 : a.y>node.y+.01&&a.y<node.y+node.h-.01&&Math.max(a.x,b.x)>node.x+.01&&Math.min(a.x,b.x)<node.x+node.w-.01;
    expect(crosses).toBe(false);
   }
  }
 }
},10000);
