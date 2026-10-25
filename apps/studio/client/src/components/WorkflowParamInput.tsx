import { useState } from 'react';
import { type InputShape, type RunInputDefinition, inputShapeLabel, validateInputShape } from '@openhilo/itt-contracts/run-inputs';
import { inferInputType, initialShapeValue } from '../lib/workflow-inputs';

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const control = 'w-full min-w-0 rounded border border-gray-200 bg-white px-2.5 py-2 text-sm text-ink focus:outline-none focus:border-teal-600 disabled:opacity-50';
const action = 'text-xs text-teal-800 underline underline-offset-2 disabled:opacity-50';
type Props = { definition: unknown; label: string; value: unknown; onChange(value: unknown): void; disabled?: boolean; error?: string };
type FieldProps = { shape: InputShape; path: string; name: string; value: unknown; onChange(value: unknown): void; disabled?: boolean; showErrors: boolean };

/** One recursive form for new runs, run-again defaults and schedule inputs. */
export function WorkflowParamInput({ definition, label, value, onChange, disabled, error }: Props) {
  const shape = (definition as RunInputDefinition | undefined)?.shape ?? {type: inferInputType(definition)};
  return <div><Field shape={shape} path={label} name={label} value={value} onChange={onChange} disabled={disabled} showErrors={!!error} />
    {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
  </div>;
}

function Field(props: FieldProps) {
  const {shape, path, name, value, onChange, disabled, showErrors} = props;
  const [touched, setTouched] = useState(false);
  let error: string | undefined;
  if (showErrors || touched) try { validateInputShape(value, shape, path); } catch(e) { error = (e as Error).message; }
  if (shape.type === 'object') return <ObjectField {...props} shape={shape} />;
  if (shape.type === 'array') return <ArrayField {...props} shape={shape} />;
  if (shape.type === 'tuple') return <TupleField {...props} shape={shape} />;
  if (shape.type === 'union') return <UnionField {...props} shape={shape} />;
  const label = <span className="mb-1 block text-sm font-medium text-ink">{name}<span className="ml-2 text-xs font-normal text-muted">{inputShapeLabel(shape)}</span></span>;
  const update = (next: unknown) => {setTouched(true); onChange(next);};
  if (shape.type === 'literal' || shape.type === 'null') return <div>{label}<div className="text-sm text-muted">{JSON.stringify(shape.type === 'literal' ? shape.value : null)}</div></div>;
  if (shape.type === 'json') return <JsonField {...props} />;
  if (shape.type === 'number') return <NumericField {...props} />;
  return <label className="block min-w-0">{label}
    {shape.type === 'boolean' ? <select className={control} aria-label={path} disabled={disabled} value={String(value)} onChange={e => update(e.target.value === 'true')}><option value="true">true</option><option value="false">false</option></select>
      : <input className={control} aria-label={path} aria-invalid={!!error}  disabled={disabled}
          value={typeof value === 'string' || typeof value === 'number' ? value : ''} onBlur={() => setTouched(true)}
          placeholder={shape.type === 'file' ? 'File path' : shape.type === 'dir' ? 'Directory path' : undefined}
          onChange={e => {const raw = e.target.value; update(raw);}} />}
    {error && <span className="mt-1 block text-xs text-red-700">{error}</span>}
  </label>;
}

function NumericField({name,path,value,onChange,disabled,showErrors}: FieldProps) {
  const [raw,setRaw] = useState(value === undefined ? '' : String(value));
  const [touched,setTouched] = useState(false);
  const valid = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) && Number.isFinite(Number(raw)) && !Object.is(Number(raw),-0);
  const invalid = !valid && (touched || showErrors);
  return <label className="block"><span className="mb-1 block text-sm font-medium">{name}<span className="ml-2 text-xs font-normal text-muted">number</span></span>
    <input className={control} aria-label={path} inputMode="decimal" aria-invalid={invalid} value={raw} disabled={disabled} onBlur={()=>setTouched(true)} onChange={e=>{const next=e.target.value;setRaw(next);const number=Number(next);onChange(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(next) && Number.isFinite(number) && !Object.is(number,-0) ? number : next);}} />
    {invalid && <span className="mt-1 block text-xs text-red-700">Enter a finite number</span>}
  </label>;
}

function JsonField({name, path, value, onChange, disabled}: FieldProps) {
  const [raw,setRaw] = useState(value === undefined ? '' : JSON.stringify(value,null,2));
  const [error,setError] = useState('');
  return <label className="block"><span className="mb-1 block text-sm font-medium">{name}<span className="ml-2 text-xs font-normal text-muted">JSON · no declared fields</span></span>
    <textarea className={`${control} font-mono`} rows={4} aria-label={path} aria-invalid={!!error} value={raw} disabled={disabled} onChange={e => {
      setRaw(e.target.value);
      try { const next = JSON.parse(e.target.value, (_key,v) => {if(typeof v === 'number' && (!Number.isFinite(v) || Object.is(v,-0))) throw new Error(); return v;}); setError(''); onChange(next); }
      catch { setError('Enter valid JSON'); onChange(undefined); }
    }} />{error && <span className="text-xs text-red-700">{error}</span>}
  </label>;
}

function ObjectField(props: FieldProps & {shape: Extract<InputShape,{type:'object'}>}) {
  const {shape,name,path,value,onChange,disabled} = props;
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
  const [newKey,setNewKey] = useState('');
  const set = (key: string, next: unknown) => onChange({...object,[key]:next});
  const remove = (key: string) => {const next = {...object}; delete next[key]; onChange(next);};
  const additional = shape.additional ?? shape.numericAdditional;
  const numericKeys = shape.numericKeys || (!shape.additional && !!shape.numericAdditional);
  const extras = Object.keys(object).filter(key => !hasOwn(shape.properties,key));
  return <fieldset className="min-w-0 space-y-3 rounded-lg border border-gray-200 bg-white/60 p-3"><legend className="px-1 text-sm font-semibold text-ink">{name}</legend>
    {Object.entries(shape.properties).map(([key,property]) => <div key={key} className="min-w-0">
      {property.optional && <label className="mb-2 flex gap-2 text-xs text-muted"><input type="checkbox" disabled={disabled} checked={hasOwn(object,key)} aria-label={`Include ${path}.${key}`} onChange={e => e.target.checked ? set(key, initialShapeValue(property.shape)) : remove(key)} />{key} (optional)</label>}
      {(!property.optional || hasOwn(object,key)) && <Field {...props} shape={property.shape} name={key} path={`${path}.${key}`} value={object[key]} onChange={next => set(key,next)} />}
    </div>)}
    {extras.map(key => <div key={key} className="space-y-1"><Field {...props} shape={(key.trim() !== '' && Number.isFinite(Number(key)) ? shape.numericAdditional : undefined) ?? shape.additional ?? {type:'json'}} path={`${path}.${key}`} name={key} value={object[key]} onChange={next => set(key,next)} /><button type="button" disabled={disabled} className={action} aria-label={`Remove ${path}.${key}`} onClick={() => remove(key)}>Remove field</button></div>)}
    {additional && <div className="flex items-center gap-2"><input className={control} disabled={disabled} aria-label={`${path} new field name`} placeholder={numericKeys ? 'Numeric key' : 'Field name'} value={newKey} onChange={e => setNewKey(e.target.value)} /><button type="button" className={`${action} shrink-0`} disabled={disabled || hasOwn(object,newKey) || !newKey || (!!numericKeys && !Number.isFinite(Number(newKey)))} onClick={() => {set(newKey,initialShapeValue(additional!)); setNewKey('');}}>Add field</button></div>}
  </fieldset>;
}

function ArrayField(props: FieldProps & {shape: Extract<InputShape,{type:'array'}>}) {
  const {value,onChange,shape,name,path,disabled} = props;
  const items = Array.isArray(value) ? value : [];
  // Re-mount indexed editors after deletion so raw JSON drafts cannot move to another item.
  const [version,setVersion] = useState(0);
  return <fieldset className="min-w-0 space-y-2 rounded border border-gray-200 p-3"><legend className="px-1 text-sm font-medium">{name} <span className="text-xs font-normal text-muted">{items.length} items</span></legend>
    {items.map((item,index) => <div key={`${version}:${index}`} className="flex items-start gap-2"><div className="min-w-0 flex-1"><Field {...props} shape={shape.items} path={`${path}[${index}]`} name={`Item ${index+1}`} value={item} onChange={next => onChange(items.map((old,i) => i === index ? next : old))} /></div><button type="button" className={`${action} mt-7 shrink-0`} disabled={disabled} aria-label={`Remove ${path}[${index}]`} onClick={() => {setVersion(v=>v+1); onChange(items.filter((_,i)=>i!==index));}}>Remove</button></div>)}
    <button type="button" className={action} disabled={disabled} aria-label={`Add ${path} item`} onClick={() => onChange([...items,initialShapeValue(shape.items)])}>Add item</button>
  </fieldset>;
}

function UnionField(props: FieldProps & {shape: Extract<InputShape,{type:'union'}>}) {
  const {shape,value,onChange,path,name,disabled}=props;
  const [selected,setSelected]=useState(() => Math.max(0,shape.options.findIndex(option => {try{validateInputShape(value,option,path);return true;}catch{return false;}})));
  const allLiterals=shape.options.every(option => option.type==='literal' || option.type==='null');
  return <div className="space-y-2"><label className="block text-sm font-medium">{name}<select className={`${control} mt-1`} aria-label={allLiterals ? path : `${path} type`} disabled={disabled} value={selected} onChange={e => {const index=Number(e.target.value);setSelected(index);onChange(initialShapeValue(shape.options[index]));}}>{shape.options.map((option,index) => <option key={index} value={index}>{inputShapeLabel(option)}</option>)}</select></label>
    {!allLiterals && <Field {...props} key={selected} shape={shape.options[selected]} name={name} />}
  </div>;
}

function TupleField(props: FieldProps & {shape: Extract<InputShape,{type:'tuple'}>}) {
  const {shape,value,onChange,name,path,disabled}=props;
  const items=Array.isArray(value)?value:[];
  const restIndex=shape.items.findIndex(item=>item.rest);
  const restCount=restIndex<0?0:Math.max(0,items.length-(shape.items.length-1));
  const [version,setVersion]=useState(0);
  const parts=shape.items.flatMap((part,index) => part.rest ? Array.from({length:restCount},()=>part) : [part]);
  return <fieldset className="min-w-0 space-y-2 rounded border border-gray-200 p-3"><legend className="px-1 text-sm font-medium">{name}</legend>
    {parts.map((part,index) => <div key={`${version}:${index}`}>
      {index < items.length ? <><Field {...props} shape={part.shape} path={`${path}[${index}]`} name={`Item ${index+1}`} value={items[index]} onChange={next=>onChange(items.map((old,i)=>i===index?next:old))} />
        {(part.rest || (part.optional && index===items.length-1)) && <button type="button" className={action} disabled={disabled} aria-label={`Remove ${path}[${index}]`} onClick={()=>{setVersion(v=>v+1);onChange(items.filter((_,i)=>i!==index));}}>Remove item</button>}</>
        : part.optional && index===items.length ? <button type="button" className={action} disabled={disabled} onClick={()=>onChange([...items,initialShapeValue(part.shape)])}>Add optional item {index+1}</button> : null}
    </div>)}
    {restIndex>=0 && <button type="button" className={action} disabled={disabled} aria-label={`Add ${path} item`} onClick={()=>{const next=[...items]; next.splice(restIndex+restCount,0,initialShapeValue(shape.items[restIndex].shape));setVersion(v=>v+1);onChange(next);}}>Add item</button>}
  </fieldset>;
}
