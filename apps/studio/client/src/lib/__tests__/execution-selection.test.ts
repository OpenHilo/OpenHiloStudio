import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExecutionGraph} from '../../components/ExecutionGraph';
import type {LogEvent} from '../trace-layout';
jest.mock('../../components/WorkflowGraph',()=>({WorkflowGraph:()=>null}));
const nodes={loop:{id:'loop',type:'for_each',next_body:'work',next_exit:'END'},work:{id:'work',type:'call'}};
const events:LogEvent[]=[
 {event:'node_pending',node_id:'loop',node_type:'for_each',node_run_id:'l1',frame_id:'root'},
 {event:'node_success',node_run_id:'l1',outputs:{condition_result:true}},
 {event:'node_pending',node_id:'work',node_run_id:'w1',frame_id:'root'},
 {event:'node_success',node_run_id:'w1'},
 {event:'continue_inline',loop_node_id:'loop',trigger_node_run_id:'w1',condition_result:true},
];
test('an inline loop occurrence is inspectable even without an independent artifact',()=>{
 const html=renderToStaticMarkup(createElement(ExecutionGraph,{nodes,entry:'loop',events,history:[],inspector:{onClose:()=>{}}} as any));
 const button=html.match(/<button[^>]*aria-label="For each item\. Iteration 2\.[^>]*>/)?.[0];
 expect(button).toBeDefined();
 expect(button).not.toMatch(/disabled/);
 expect(button).toContain('Open step details');
});

test('selection uses occurrence identity, not shared loop node ID or absent artifact ID',()=>{
 const html=renderToStaticMarkup(createElement(ExecutionGraph,{nodes,entry:'loop',events,history:[],onStepClick:()=>{},selectedStepKey:'inline:4',inspector:{onClose:()=>{}}}));
 const selected=html.match(/<button[^>]*aria-pressed="true"[^>]*>/g) ?? [];
 // The execution-path view switch is also pressed; only one execution node is selected.
 const selectedNodes=selected.filter(button=>button.includes('execution-node'));
 expect(selectedNodes).toHaveLength(1);
 expect(selectedNodes[0]).toContain('Iteration 2');
});

import {ExecutionStepSummary} from '../../components/ExecutionStepSummary';
import {buildExecutionPath} from '../execution-path';
test('inline entry and exit report their own evidence without inventing I/O or a condition',()=>{
 const path=buildExecutionPath(nodes,[...events,{event:'continue_inline',loop_node_id:'loop',trigger_node_run_id:'w1',condition_result:false}]);
 const entry=path.steps.find(step=>step.row.key==='inline:4')!;
 const exit=path.steps.find(step=>step.exit)!;
 const entryHtml=renderToStaticMarkup(createElement(ExecutionStepSummary,{step:entry}));
 expect(entry.row.nodeRunId).toBeUndefined();
 expect(entryHtml).toContain('<dd>2</dd>');
 expect(entryHtml).toContain('<dd>True</dd>');
 expect(entryHtml).toContain('Enter loop body');
 const exitHtml=renderToStaticMarkup(createElement(ExecutionStepSummary,{step:exit}));
 expect(exitHtml).toContain('<dd>False</dd>');
 expect(exitHtml).toContain('Exit loop');
 expect(exitHtml).not.toContain('Iteration');
 const unknownHtml=renderToStaticMarkup(createElement(ExecutionStepSummary,{step:{row:{...entry.row,outputs:undefined}}}));
 expect(unknownHtml).not.toContain('Condition');
 expect(unknownHtml).not.toContain('Enter loop body');
});

test('a computation-only workflow retains an inspectable result step', () => {
 const computation={assign:{id:'assign',type:'assign',next:'END'}};
 const path=buildExecutionPath(computation,[
  {event:'node_pending',node_id:'assign',node_run_id:'a1',frame_id:'root'},
  {event:'node_success',node_run_id:'a1',outputs:{answer:42}},
  {event:'run_complete'},
 ]);
 expect(path.terminal).toBe('completed');
 expect(path.steps).toHaveLength(1);
 expect(path.steps[0].row.nodeRunId).toBe('a1');
 expect(path.steps[0].row.outputs).toEqual({answer:42});
});
