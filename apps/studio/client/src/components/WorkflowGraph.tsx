import {useMemo, useState, useEffect} from 'react';
import {IttFlowchart, type IttFlowchartProps} from './IttFlowchart';
import {buildWorkflowLayout} from '../lib/workflow-layout';
import type {CFGNode, LogEvent} from '../lib/trace-layout';
import {describeNode} from '../lib/execution-presentation';
import {CodeViewer} from './CodeViewer';
import {GraphWorkspace} from './GraphWorkspace';
const NO_EVENTS:LogEvent[]=[];
export function WorkflowGraph({nodes,entry,events=NO_EVENTS,onNodeClick}: {nodes:Record<string,CFGNode>;entry:string;events?:LogEvent[];onNodeClick?:IttFlowchartProps['onNodeClick']}) {
  const [technical,setTechnical]=useState(false);
  const [selected,setSelected]=useState<string>();
  const layout=useMemo(()=>buildWorkflowLayout(nodes,entry,events,technical),[nodes,entry,events,technical]);
  const [routed,setRouted]=useState<typeof layout>();
  const [layoutError,setLayoutError]=useState('');
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let active=true;setRouted(undefined);setLayoutError('');
    import('../lib/route-workflow').then(({routeWorkflow})=>routeWorkflow(layout))
      .then(result=>{if(active)setRouted(result);})
      .catch(error=>{if(active)setLayoutError(String(error));});
    return ()=>{active=false;};
  },[layout,retry]);
  return <section>
    {layout.warnings.length > 0 && <div role="alert" className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-amber-900"><p>This diagram may be incomplete.</p><ul>{layout.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></div>}
    <div className="flex flex-wrap justify-between gap-3 items-center mb-3"><p className="text-sm text-muted">{events.length ? 'Saved workflow structure. Status shows the latest invocation; Activity shows every attempt.' : 'Workflow structure. Branches show possible paths.'}</p><label className="text-sm flex items-center gap-2"><input type="checkbox" checked={technical} onChange={e=>setTechnical(e.target.checked)} />Show internal steps</label></div>
    <GraphWorkspace selectionKey={selected} title={selected && nodes[selected] ? describeNode(nodes[selected]).title : undefined} subtitle="Workflow definition" onClose={()=>setSelected(undefined)} details={selected && nodes[selected] && <><p className="text-sm mb-4">{describeNode(nodes[selected]).description ?? 'No description recorded for this step.'}</p><h4>Definition</h4><CodeViewer code={JSON.stringify(nodes[selected],null,2)} /></>}>
    {layoutError?<p role="alert" className="text-sm text-red-700">Unable to draw workflow: {layoutError} <button className="underline" onClick={()=>setRetry(n=>n+1)}>Retry diagram</button></p>:!routed?<p role="status" className="p-6 text-muted">Laying out workflow…</p>:<div className="workflow-canvas"><IttFlowchart showStatus={events.length > 0} layout={routed} onNodeClick={(id,run,x,y,error)=>{if(run&&onNodeClick){setSelected(undefined);onNodeClick(id,run,x,y,error);}else setSelected(id);}} /></div>}
    </GraphWorkspace>
  </section>;
}
