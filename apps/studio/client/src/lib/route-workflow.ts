import ELK, {type ElkNode} from 'elkjs/lib/elk.bundled.js';
import type {TraceLayout, TraceEdge} from './trace-layout';
const labels: Partial<Record<TraceEdge['kind'],string>> = {next_true:'True',next_false:'False',next_body:'Repeat',next_exit:'Exit'};
const elk = new ELK(); // Bundled in-process engine; no external Worker to terminate.
/** ELK owns both placement and orthogonal routing. Never recompute edges in the renderer. */
export async function routeWorkflow<T extends TraceLayout>(source:T):Promise<T> {
  if(!source.items.length) return {...source,routed:true};

    const graph = await elk.layout<ElkNode>({id:'workflow',layoutOptions:{
      'elk.algorithm':'layered','elk.direction':'DOWN','elk.edgeRouting':'ORTHOGONAL',
      'elk.padding':'[top=32,left=32,bottom=32,right=32]',
      'elk.spacing.nodeNode':'60','elk.layered.spacing.nodeNodeBetweenLayers':'70',
      'elk.layered.spacing.edgeNodeBetweenLayers':'25','elk.spacing.edgeNode':'25',
      'elk.layered.spacing.edgeEdgeBetweenLayers':'18','elk.spacing.edgeEdge':'18',
      'elk.layered.feedbackEdges':'true','elk.layered.mergeEdges':'false',
    },children:source.items.map<ElkNode>((item,index)=>({id:item.id,width:item.w,height:item.h,layoutOptions:{'elk.layered.layering.layerConstraint':index===0?'FIRST':item.cfg.type==='end'?'LAST':'NONE'}})),
    edges:source.edges.map((edge,i)=>({id:`edge-${i}`,sources:[edge.from],targets:[edge.to],
      labels:labels[edge.kind]?[{text:labels[edge.kind],width:52,height:22}]:[],
    }))});
    const children=new Map(graph.children?.map(child=>[child.id,child]));
    return {...source,routed:true,width:graph.width??source.width,height:graph.height??source.height,
      items:source.items.map(item=>({...item,x:children.get(item.id)?.x??0,y:children.get(item.id)?.y??0})),
      edges:source.edges.map((edge,i)=>{
        const routed=graph.edges?.find(candidate=>candidate.id===`edge-${i}`),section=routed?.sections?.[0],label=routed?.labels?.[0];
        if(!section) throw new Error('A workflow connection could not be laid out.');
        return {...edge,points:[section.startPoint,...section.bendPoints??[],section.endPoint],
          label:label?{text:label.text??'',x:label.x??0,y:label.y??0,width:label.width??52,height:label.height??22}:undefined};
      })};
}
