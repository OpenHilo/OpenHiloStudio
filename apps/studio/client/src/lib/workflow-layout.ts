import type {CFGNode, LogEvent, TraceLayout, TraceNode, TraceEdge, NodeStatus} from './trace-layout';
import {projectWorkflow} from './workflow-presentation';
import {buildExecutionActivity} from './execution-presentation';
const keys = ['next','next_true','next_false','next_body','next_exit'] as const;
/** Resolve reserved transfers using structural loop ownership, excluding nested bodies. */
function resolveLoopTransfers(source: Record<string,CFGNode>) {
  const owners = new Map<string,Set<string>>();
  for (const [loopId,loop] of Object.entries(source)) {
    if (!loop.next_body || !loop.next_exit) continue;
    const visited = new Set<string>(), queue = [loop.next_body];
    for (let i=0;i<queue.length;i++) {
      const id=queue[i],node=source[id];
      if (!node || visited.has(id) || id===loopId || id===loop.next_exit) continue;
      visited.add(id);
      const candidates=owners.get(id)??new Set<string>(); candidates.add(loopId);owners.set(id,candidates);
      // A nested loop's exit belongs to the outer body; its body has its own owner.
      const nextKeys=node.next_body ? ['next_exit'] as const : keys;
      for(const key of nextKeys) if(node[key]) queue.push(node[key]!);
    }
  }
  const nodes:Record<string,CFGNode>={},warnings:string[]=[];
  for(const [id,node] of Object.entries(source)) {
    const copy={...node};nodes[id]=copy;
    for(const key of keys) if(copy[key]==='BREAK'||copy[key]==='CONTINUE') {
      const candidates=owners.get(id);
      if(candidates?.size===1) {
        const owner=[...candidates][0];copy[key]=copy[key]==='CONTINUE'?owner:source[owner].next_exit;
      } else warnings.push(`Cannot determine the enclosing loop for ${id}. Inspect its definition details.`);
    }
  }
  return {nodes,warnings};
}
/** A compact definition view. Edges are possibilities; status comes only from persisted invocations. */
export function buildWorkflowLayout(source: Record<string, CFGNode>, entry: string, events: LogEvent[], technical = false): TraceLayout & {warnings:string[]} {
  const normalized=resolveLoopTransfers(source);
  const warnings=[...normalized.warnings];
  if(!source[entry]) warnings.push('The saved entry step is unavailable.');
  for(const node of Object.values(normalized.nodes)) for(const key of keys) if(node[key] && !['END','BREAK','CONTINUE'].includes(node[key]!) && !source[node[key]!]) warnings.push(`Missing step: ${node[key]}.`);
  const projected = projectWorkflow(normalized.nodes, entry, events, technical ? 'technical' : 'workflow');
  const nodes = {...projected.nodes};
  let endId = '__studio_end__'; while (nodes[endId]) endId += '_';
  const hasEnd = Object.values(nodes).some(node => keys.some(key => node[key] === 'END'));
  if (hasEnd) nodes[endId] = {id:endId,type:'end',callee:'End'};
  const target = (id: string) => id === 'END' ? endId : id;
  const rootFrame=events.find(e=>e.event==='node_pending')?.frame_id;
  const runs=new Set(events.filter(e=>e.event==='node_pending'&&e.frame_id===rootFrame).map(e=>e.node_run_id));
  const rows=buildExecutionActivity(events.filter(e=>e.node_run_id&&runs.has(e.node_run_id)),nodes,true);
  const items: TraceNode[]=[];
  const ordered:string[]=[],seen=new Set<string>(),queue=[projected.entry];
  for(let i=0;i<queue.length;i++) {const id=queue[i];if(!nodes[id]||seen.has(id))continue;seen.add(id);ordered.push(id);for(const key of keys)if(nodes[id][key])queue.push(target(nodes[id][key]!));}
  for(const id of Object.keys(nodes))if(!seen.has(id))ordered.push(id);
  for (const [index,id] of ordered.entries()) {
    const row=[...rows].reverse().find(r=>r.nodeId===id);
    items.push({kind:'node',id,cfg:nodes[id],x:0,y:index*120,w:250,h:76,status:(row?.status??'pending') as NodeStatus,nodeRunId:row?.nodeRunId,error:row?.error});
  }
  const edges: TraceEdge[]=[];
  for(const [id,node] of Object.entries(nodes)) for(const key of keys) if(node[key] && nodes[target(node[key]!)]) edges.push({from:id,to:target(node[key]!),kind:key});
  return {items,edges,width:250,height:items.length*120,warnings};
}
