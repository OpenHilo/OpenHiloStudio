import {useState, type CSSProperties, type ComponentProps, type KeyboardEvent} from 'react';
import {JSONTree} from 'react-json-tree';

const collection = (value: unknown): value is Record<string, unknown> | unknown[] => value !== null && typeof value === 'object';
const activate = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); }
};
const theme: ComponentProps<typeof JSONTree>['theme'] = {
  tree: {backgroundColor:'transparent', margin:0, userSelect:'text'},
  value: ({style}: {style?: CSSProperties}) => ({style:{...style, marginLeft:0, paddingLeft:0, textIndent:0, wordBreak:'normal', overflowWrap:'anywhere'}}),
  label: {color:'#116149', whiteSpace:'pre-wrap', overflowWrap:'anywhere'},
  valueText: {whiteSpace:'pre-wrap', overflowWrap:'anywhere'},
  nestedNode: {marginLeft:0},
  nestedNodeChildren: {marginLeft:'0.75rem', borderLeft:'1px solid #dce3e8', paddingLeft:'0.75rem'},
  nestedNodeItemString: {color:'#60717b'},
  arrowSign: {color:'#116149'},
  itemRange: ({style}: {style?: CSSProperties}, expanded: unknown) => ({
    style:{...style, color:'#116149', cursor:'pointer', padding:'0.35rem 0'},
    ...(expanded ? {} : {role:'button', tabIndex:0, onKeyDown:activate, 'aria-label':'Expand item range'}),
  }),
};
function Scalar({value}: {value: unknown}) {
  const text = value === undefined ? 'Not recorded' : value === null ? 'null' : String(value);
  const color = typeof value === 'string' ? '#175b9c' : typeof value === 'boolean' ? '#9e382e' : typeof value === 'number' ? '#7040a0' : '#60717b';
  if (text === '') return <em className="text-muted">Empty text</em>;
  if (typeof value === 'string' && text.length > 500) return <details className="inline-block align-top max-w-full">
    <summary className="cursor-pointer text-muted">Text · {text.length.toLocaleString()} characters · {text.slice(0, 80)}…</summary>
    <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]" style={{color}}>{text}</div>
  </details>;
  return <span style={{color}}>{text}</span>;
}
/** Read-only adapter: nesting, lazy expansion and collection ranges belong to react-json-tree. */
export function ValueViewer({value}: {value: unknown}) {
  const [raw, setRaw] = useState(false);
  const complex = collection(value) && (Array.isArray(value) || Object.values(value).some(collection));
  const empty = collection(value) && Object.keys(value).length === 0;
  return <div className="bg-[#f6f8fa] text-[#203039] rounded p-3 min-w-0 max-w-full [overflow-wrap:anywhere] text-xs font-mono leading-relaxed">
    {complex && <div className="flex justify-end mb-2">
      <button type="button" className="min-h-9 text-teal-800 underline underline-offset-2" aria-pressed={raw} onClick={() => setRaw(v => !v)}>{raw ? 'View fields' : 'View JSON'}</button>
    </div>}
    {raw ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(value, null, 2)}</pre>
      : empty ? <em className="text-muted">{Array.isArray(value) ? 'No items' : 'No fields'}</em>
      : !collection(value) ? <div className="whitespace-pre-wrap"><Scalar value={value}/></div>
      : <JSONTree data={value} hideRoot theme={theme} invertTheme={false} collectionLimit={25}
          shouldExpandNodeInitially={(_path, _data, level) => level < 2}
          labelRenderer={([key], _type, expanded, expandable) => {
            const label = typeof key === 'number' ? `[${key}]` : key || '(empty key)';
            return expandable ? <button type="button" className="text-left cursor-pointer" aria-expanded={expanded}>{label}:</button> : <span>{label}:</span>;
          }}
          getItemString={(type, data) => {
            const count = Object.keys(data as object).length;
            return <span>{type === 'Array' ? `Array · ${count} items` : `Object · ${count} fields`}</span>;
          }}
          valueRenderer={(_formatted, original) => <Scalar value={original}/>}
        />}
  </div>;
}
