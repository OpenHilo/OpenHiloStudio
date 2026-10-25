import type {LogEvent} from './trace-layout';

export interface ExecutionFrame {
  id: string; title: string; call: number; parentId?: string; parentNodeRunId?: string;
  status: string; depth: number;
}
/** Frame identity, rather than callee/node names, distinguishes recursion and loop calls. */
export function executionFrames(events: LogEvent[]): ExecutionFrame[] {
  const first = events.find(event => event.event === 'node_pending');
  if (typeof first?.frame_id !== 'string') return [];
  const root: ExecutionFrame = {id:first.frame_id, title:String(first.intent_name ?? 'Root workflow'), call:1, status:'running', depth:0};
  const frames = new Map<string, ExecutionFrame>([[root.id, root]]);
  const calls = new Map<string, LogEvent>();
  const counts = new Map<string, number>();
  const stack = [root.id];
  let running: LogEvent | undefined;
  for (const event of events) {
    if (event.event === 'node_pending' && event.node_run_id) {calls.set(event.node_run_id,event);running=event;}
    if (event.event === 'node_running' && event.node_run_id) running=calls.get(event.node_run_id);
    if (event.event === 'frame_push' && typeof event.frame_id === 'string' && !frames.has(event.frame_id)) {
      const title=String(event.callee ?? 'Child workflow');
      const call=(counts.get(title) ?? 0)+1; counts.set(title,call);
      // The runtime pushes a frame immediately after starting its intent call.
      // Do not attach it to an unrelated AI/Code call in incomplete legacy logs.
      const parent=running?.executor === 'intent' ? running : undefined;
      const parentId=typeof parent?.frame_id === 'string' ? parent.frame_id : stack.at(-1);
      frames.set(event.frame_id,{id:event.frame_id,title,call,parentId,parentNodeRunId:parent?.node_run_id,status:'running',depth:(frames.get(parentId ?? '')?.depth ?? 0)+1});
      stack.push(event.frame_id);
    }
    if (event.event === 'frame_pop' && typeof event.frame_id === 'string') {
      const frame=frames.get(event.frame_id); if(frame)frame.status='completed';
      const index=stack.lastIndexOf(event.frame_id);if(index>=0)stack.splice(index);
    }
    const invocation=event.node_run_id ? calls.get(event.node_run_id) : undefined;
    if(invocation && ['node_pending','node_running','node_suspended','node_failed'].includes(event.event)) {
      let frame=frames.get(String(invocation.frame_id));
      const status=event.event==='node_suspended'?'suspended':event.event==='node_failed'?'failed':'running';
      while(frame) {if(frame.status!=='completed')frame.status=status;frame=frames.get(frame.parentId ?? '');}
    }
    if(event.event==='run_complete')root.status='completed';
    if(event.event==='run_failed'||event.event==='run_abort') {
      for(const frame of frames.values())if(frame.status!=='completed')frame.status=event.event==='run_failed'?'failed':'aborted';
    }
    if(event.event==='run_resume')for(const frame of frames.values())if(frame.status!=='completed')frame.status='running';
  }
  return [...frames.values()];
}
