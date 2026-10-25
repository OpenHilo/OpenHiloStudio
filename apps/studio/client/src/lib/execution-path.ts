import type {CFGNode, LogEvent} from './trace-layout';
import type {HumanHistoryItem} from '../api/human';
import {buildExecutionActivity, describeNode, type ActivityItem} from './execution-presentation';

export interface ExecutionPathStep {
  row: ActivityItem;
  decision?: boolean;
  alternative?: string;
  alternativeTarget?: string;
  iteration?: number;
  exit?: boolean;
  transfer?: 'Break' | 'Continue';
}
/** Execution is a sequence of occurrences, not a static CFG with last-state paint. */
export function buildExecutionPath(nodes:Record<string,CFGNode>, events:LogEvent[], history:HumanHistoryItem[]=[], technical=false, frameId?:string) {
  const rootFrame=events.find(event=>event.event==='node_pending')?.frame_id;
  const scope=frameId ?? rootFrame;
  const rows=buildExecutionActivity(events,nodes,true,history).filter(row=>row.frameId===scope);
  // Child definitions may not be served by older servers. Use recorded types only;
  // never apply the root CFG to a child's coincidentally identical node IDs.
  if(scope!==rootFrame) nodes=Object.fromEntries(rows.filter(row=>row.nodeId).map(row=>[row.nodeId!,{id:row.nodeId!,type:row.kind,executor:row.executor}]));
  const rootRuns=new Set(events.filter(event=>event.event==='node_pending'&&event.frame_id===scope).map(event=>event.node_run_id));
  // Preserve actual final artifact IDs when a durable human request spans attempts.
  for(const row of rows) if(row.executor==='human') {
    const last=[...row.sourceEventIndexes].reverse().map(i=>events[i]).find(event=>event.node_run_id);
    if(last?.node_run_id) row.nodeRunId=last.node_run_id;
  }
  events.forEach((event,index)=>{
    if(event.event!=='continue_inline'||typeof event.loop_node_id!=='string'||typeof event.trigger_node_run_id!=='string'||!rootRuns.has(event.trigger_node_run_id)) return;
    const node=nodes[event.loop_node_id]; if(!node) return;
    rows.push({key:`inline:${index}`,...describeNode(node),nodeId:node.id,frameId:typeof scope==='string'?scope:undefined,status:'completed',outputs:{condition_result:event.condition_result},sourceEventIndexes:[index]});
  });
  rows.sort((a,b)=>a.sourceEventIndexes[0]-b.sourceEventIndexes[0]);
  const counters=new Map<string,number>(), totals=new Map<string,number>();
  const steps:ExecutionPathStep[]=[];
  const activeLoops:string[]=[];
  for(const row of rows) {
    const node=row.nodeId ? nodes[row.nodeId] : undefined;
    const transfer=row.status==='completed' && node?.next==='BREAK' ? 'Break' : row.status==='completed' && node?.next==='CONTINUE' ? 'Continue' : undefined;
    if(!technical && row.kind==='assign'&&row.status==='completed'&&!transfer) continue;
    const step:ExecutionPathStep={row};
    if(transfer) {step.transfer=transfer;row.title=transfer==='Break'?'Leave loop':'Continue loop';
      if(transfer==='Break') {const exited=activeLoops.pop();if(exited)counters.set(exited,0);}
    }
    const output=row.outputs as {condition_result?:unknown;next?:unknown;iteration?:unknown}|undefined;
    if(node?.type==='if'&&typeof output?.condition_result==='boolean') {
      step.decision=output.condition_result;
      step.alternative=output.condition_result?'False · not taken':'True · not taken';
      const target=nodes[(output.condition_result?node.next_false:node.next_true)??''];
      if(target?.type==='call') step.alternativeTarget=describeNode(target).title;
    }
    if(node && ((node.next_body && node.next_exit) || (scope!==rootFrame && ['for','while','for_each','foreach'].includes(node.type)))) {
      const enter=output?.condition_result===true || (output?.condition_result===undefined && node.next_body!==undefined && output?.next===node.next_body);
      const exit=output?.condition_result===false || (output?.condition_result===undefined && node.next_exit!==undefined && output?.next===node.next_exit);
      if(enter) {if(output?.iteration==='first')counters.set(node.id,0);if(!activeLoops.includes(node.id))activeLoops.push(node.id);const count=(counters.get(node.id)??0)+1;counters.set(node.id,count);totals.set(node.id,(totals.get(node.id)??0)+1);step.iteration=count;}
      if(exit) {step.exit=true;counters.set(node.id,0);const active=activeLoops.lastIndexOf(node.id);if(active>=0)activeLoops.splice(active);}
    }
    steps.push(step);
  }
  // Keep computation-only workflows inspectable when their successful assignments
  // would otherwise hide every recorded occurrence.
  if (!steps.length && rows.length) steps.push({row: rows[rows.length - 1]});
  const final=[...events].reverse().find(event=>['run_complete','run_failed','run_abort','run_resume'].includes(event.event));
  const returned=scope!==rootFrame && events.some(event=>event.event==='frame_pop'&&event.frame_id===scope);
  const terminal=returned?'completed':final?.event==='run_complete'?'completed':final?.event==='run_failed'?'failed':final?.event==='run_abort'?'aborted':undefined;
  return {steps,terminal,loops:[...totals].map(([id,entries])=>({id,title:describeNode(nodes[id]).title,entries}))};
}
