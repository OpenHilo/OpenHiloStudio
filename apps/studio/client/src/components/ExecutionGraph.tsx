import {useMemo,useRef,useState} from 'react';
import type {CFGNode,LogEvent} from '../lib/trace-layout';
import type {HumanHistoryItem} from '../api/human';
import {buildExecutionPath, type ExecutionPathStep} from '../lib/execution-path';
import {elapsedTime} from '../lib/execution-time';
import {WorkflowGraph} from './WorkflowGraph';
import {GraphWorkspace, type GraphWorkspaceProps} from './GraphWorkspace';
import {executionFrames} from '../lib/execution-frames';
import {useRunArtifact} from '../hooks/useRunArtifact';
import {decodeSnapshot} from '../api/run-artifacts';
const frameStatus=(status:string)=>status==='suspended'?'Waiting for input':status==='running'?'Running':status==='completed'?'Completed':status==='failed'?'Failed':'Stopped';
export function ExecutionGraph({runId,nodes,entry,events,history,onStepClick,selectedStepKey,onViewChange,inspector}: {runId?:string;nodes:Record<string,CFGNode>;entry:string;events:LogEvent[];history:HumanHistoryItem[];onStepClick:(step:ExecutionPathStep)=>void;selectedStepKey?:string;onViewChange?:()=>void;inspector:Omit<GraphWorkspaceProps,'children'>}) {
  const [definition,setDefinition]=useState(false),[technical,setTechnical]=useState(false);
  const [selectedFrame,setSelectedFrame]=useState<string>();
  const latest=useRef<HTMLLIElement>(null);
  const frames=useMemo(()=>executionFrames(events),[events]);
  const frame=frames.find(item=>item.id===selectedFrame) ?? frames[0];
  const child=Boolean(frame?.parentId);
  const childDefinition=useRunArtifact(definition&&child&&runId ? `/api/runs/${encodeURIComponent(runId)}/snapshot?frameId=${encodeURIComponent(frame!.id)}` : undefined,decodeSnapshot);
  const path=useMemo(()=>buildExecutionPath(nodes,events,history,technical,frame?.id),[nodes,events,history,technical,frame?.id]);
  const focusFrame=frames.filter(item=>['running','suspended'].includes(item.status)).sort((a,b)=>b.depth-a.depth)[0];
  const changeFrame=(id:string)=>{setSelectedFrame(id);onViewChange?.();};
  return <section aria-label="Run execution">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div className="view-switch"><button aria-pressed={!definition} onClick={()=>{setDefinition(false);onViewChange?.();}}>Execution path</button><button aria-pressed={definition} onClick={()=>{setDefinition(true);onViewChange?.();}}>Saved definition</button></div>
      {!definition&&<label className="text-xs text-muted flex gap-2 items-center"><input type="checkbox" checked={technical} onChange={event=>setTechnical(event.target.checked)} />Show internal steps</label>}
    </div>
    {frames.length>1&&<nav aria-label="Workflow calls" className="rounded-lg border border-line bg-white p-3 mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {child&&<button className="subtle-link text-sm" onClick={()=>changeFrame(frame!.parentId!)}>← Parent workflow</button>}
        <label className="text-sm min-w-0 flex-1">Workflow call
          <select aria-label="Workflow call" className="block mt-1 w-full min-w-0 rounded border border-line bg-white p-2 text-sm" value={frame?.id} onChange={event=>changeFrame(event.target.value)}>
            {frames.map(item=><option key={item.id} value={item.id}>{item.depth?'↳ '.repeat(item.depth):''}{item.title}{item.parentId?` · Call ${item.call}`:' · Root'} · {frameStatus(item.status)}</option>)}
          </select>
        </label>
      </div>
      {focusFrame&&focusFrame.id!==frame?.id&&<button className="subtle-link text-sm text-left" onClick={()=>{setDefinition(false);changeFrame(focusFrame.id);}}>{frameStatus(focusFrame.status)} in {focusFrame.title} · View steps →</button>}
    </nav>}
    {definition?(child ? childDefinition.error ? <div role="alert" className="rounded border border-red-200 p-4 text-sm text-red-800">Could not load the saved definition for {frame?.title}: {childDefinition.error} <button className="underline" onClick={childDefinition.retry}>Retry</button></div> : childDefinition.data ? <WorkflowGraph key={frame?.id} nodes={childDefinition.data.nodes as Record<string,CFGNode>} entry={childDefinition.data.entry} /> : <p role="status">Loading saved definition for {frame?.title}…</p> : <WorkflowGraph nodes={nodes} entry={entry} />):<GraphWorkspace {...inspector}>
      <div className="flex flex-wrap items-center gap-4 mb-4 text-xs text-muted"><span>Steps actually taken in this workflow call.</span>{path.loops.map(loop=><span key={loop.id} className="loop-count">{loop.title}: {loop.entries} {loop.entries===1?'iteration entered':'iterations entered'}</span>)}<button className="subtle-link ml-auto" onClick={()=>latest.current?.scrollIntoView({block:'nearest'})}>Latest step</button></div>
      <div className="execution-canvas" role="group" aria-label="Actual execution path">
        {!path.steps.length&&<p className="p-6 text-muted">No recorded steps yet.</p>}
        <ol className="execution-path">{path.steps.map((step,index)=>{
          const {row}=step;
          const actor=row.executor==='ai'?'AI':row.executor==='human'?'Human':row.executor==='code'?'Code':row.kind==='call'?'Workflow':'Control';
          const status=row.status==='aborted'?'Stopped':row.status==='resuming'?'Continuing':row.status==='suspended'?'Waiting for input':row.status==='completed'?'Completed':row.status==='failed'?'Failed':'Running';
          const elapsed=row.status==='completed'?elapsedTime(row.startedAt,row.endedAt):undefined;
          const children=frames.filter(item=>item.parentNodeRunId===row.nodeRunId);
          return <li key={row.key} ref={index===path.steps.length-1?latest:undefined} className="execution-step">
            {step.iteration&&<div className="iteration-heading">Iteration {step.iteration}</div>}
            {step.exit&&<div className="iteration-heading">Loop condition is false · exit</div>}
            <button className="execution-node" data-status={row.status} aria-pressed={selectedStepKey===row.key} aria-label={`${row.title}. ${step.iteration?`Iteration ${step.iteration}. `:''}${status}. ${step.decision!==undefined?`Condition ${step.decision}. `:''}Open step details`} onClick={()=>onStepClick(step)}>
              <div className="flex justify-between items-center gap-3 mb-2"><span className="actor-badge" data-actor={row.executor}>{actor}</span><span className="status-chip" data-status={row.status}>{status}</span></div>
              <div className="font-semibold text-sm break-words">{row.kind==='if'&&<span className="mr-2 text-blue-700" aria-hidden="true">◇</span>}{row.title}</div>
              {(elapsed||step.decision!==undefined)&&<div className="mt-1 text-xs text-muted">{step.decision!==undefined?`Condition: ${step.decision ? 'True' : 'False'}`:elapsed}</div>}
            </button>
            {children.map(item=><button key={item.id} className="w-full rounded-b-lg border border-t-0 border-line bg-white px-4 py-3 text-left text-sm text-teal-800 hover:bg-teal-50" onClick={()=>changeFrame(item.id)}>View child steps · {item.title} · {frameStatus(item.status)} →</button>)}
            {step.alternative&&<aside className="untaken-path"><span>{step.alternative}</span>{step.alternativeTarget&&<small title={step.alternativeTarget}>{step.alternativeTarget}</small>}</aside>}
            {(index<path.steps.length-1||path.terminal)&&<div className="execution-connector" aria-hidden="true">{step.decision!==undefined&&<span>{step.decision?'True':'False'}</span>}{step.iteration&&<span>Enter body</span>}{step.exit&&<span>Exit loop</span>}</div>}
          </li>;
        })}
        {path.terminal&&<li className="execution-end" data-status={path.terminal}>{child?'Workflow':'Run'} {path.terminal==='completed'?'completed':path.terminal==='failed'?'failed':'stopped'}</li>}
        </ol>
      </div>
    </GraphWorkspace>}
  </section>;
}
