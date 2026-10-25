import { compileProgram } from '@openhilo/compiler';
import { encodeWorkflowInputs, initialWorkflowInput, workflowInputErrors } from '../workflow-inputs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkflowParamInput } from '../../components/WorkflowParamInput';

function schema(type: string) {
  const result = compileProgram({ files: {'fixture.ts': `export async function main(context:${type}):Promise<{value:unknown}>{return {value:context};}`}, entries: [{file:'fixture.ts',exportName:'main'}] });
  expect(result.ok).toBe(true);
  return result.artifacts[0].declaration.inputs!;
}
const definition = schema('{budget:number;currency:string;skills:string[];enabled:boolean;note?:string;mode:"light"|"pro"}');

test('compiler metadata drives fields instead of an object JSON editor', () => {
  const context = initialWorkflowInput(definition.context);
  expect(context).toEqual({budget:undefined,currency:'',skills:[],enabled:false,mode:'light'});
  const html = renderToStaticMarkup(createElement(WorkflowParamInput,{definition:definition.context,label:'context',value:context,onChange:()=>{}}));
  expect(html).toContain('aria-label="context.budget"');
  expect(html).toContain('aria-label="context.currency"');
  expect(html).toContain('aria-label="Add context.skills item"');
  expect(html).toContain('aria-label="Include context.note"');
  expect(html).toContain('<option value="1">&quot;pro&quot;</option>');
  expect(html).not.toContain('<textarea');
});

test('submission retains typed values and reports missing or mistyped nested fields', () => {
  const context={budget:0,currency:'',skills:[],enabled:false,mode:'light'};
  expect(JSON.parse(encodeWorkflowInputs({context},definition).context)).toEqual(context);
  expect(workflowInputErrors({context:{...context,budget:'wrong'}},definition).context).toContain('context.budget');
  expect(workflowInputErrors({context:{...context,skills:[undefined]}},definition).context).toContain('context.skills[0]: required');
  expect(workflowInputErrors({context:{...context,note:undefined}},definition).context).toContain('context.note: required');
  expect(workflowInputErrors({context:{...context,skills:[42]}},definition).context).toContain('context.skills[0]');
  expect(workflowInputErrors({context:{...context,budget:Infinity}},definition).context).toContain('finite');
});

test('arrays of nested objects, records and nullable values round-trip without lossy coercion',()=>{
  for(const [type,context] of [
    ['{rows:{id:number;label?:string}[]}',{rows:[{id:1},{id:2,label:'two'}]}],
    ['Record<string,boolean>',{one:false,two:true}],
    ['{value:number|null}',{value:null}],
    ['[string,...number[]]',['name',0,2]],
  ] as const){const contract=schema(type);expect(JSON.parse(encodeWorkflowInputs({context},contract).context)).toEqual(context);}
});

test('unstructured and legacy JSON retain a JSON editor, invalid edits cannot disappear',()=>{
  const contract=schema('{payload:unknown;optional?:unknown}');
  const html=renderToStaticMarkup(createElement(WorkflowParamInput,{definition:contract.context,label:'context',value:initialWorkflowInput(contract.context),onChange:()=>{}}));
  expect(html).toContain('<textarea');
  expect(workflowInputErrors({context:{payload:{},optional:undefined}},contract).context).toContain('context.optional');
});
