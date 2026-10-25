import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ValueViewer} from '../../components/ValueViewer';
const render = (value: unknown) => renderToStaticMarkup(createElement(ValueViewer, {value}));

test('keeps simple fields unquoted, colored and multiline without changing values', () => {
  const html = render({message:'第一行\n第二行', approved:false, count:0});
  expect(html).toContain('message:');
  expect(html).toContain('第一行\n第二行');
  expect(html).toContain('>false</span>');
  expect(html).toContain('>0</span>');
  expect(html).toContain('color:#175b9c');
  expect(html).not.toContain('&quot;');
  expect(html).not.toContain('{');
});
test('escapes untrusted text and preserves JSON-encoded strings as strings', () => {
  const html = render({'<img src=x>':'<script>alert(1)</script>', text:'{"id":9007199254740993}'});
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('{&quot;id&quot;:9007199254740993}');
});
test('distinguishes empty values and provides keyboard-focusable nested controls', () => {
  const html = render({records:[{ok:true}, {ok:false}], blank:'', missing:null, items:[], object:{}});
  expect(html).toContain('Array · 2 items');
  expect(html).toContain('[0]:');
  expect(html).toContain('[1]:');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('Empty text');
  expect(html).toContain('>null</span>');
  expect(html).toContain('Array · 0 items');
  expect(html).toContain('Object · 0 fields');
  expect(render([])).toContain('No items');
  expect(render({})).toContain('No fields');
  expect(render(undefined)).toContain('Not recorded');
});
test('uses library ranges for large arrays and avoids mounting deep collapsed values', () => {
  const data = {rows:Array.from({length:1000}, (_,i)=>({name:`Record ${i+1}`, detail:`detail${i+1}`}))};
  const before = JSON.stringify(data);
  const html = render(data);
  expect(html).toContain('Array · 1000 items');
  expect(html).toContain('Expand item range');
  expect(html).not.toContain('detail500');
  expect(html.length).toBeLessThan(50000);
  expect(JSON.stringify(data)).toBe(before);
  expect(html).toContain('View JSON');
});
test('long text is collapsible, wraps and retains all original content', () => {
  const text = '长段落\n'.repeat(300);
  const html = render({text});
  expect(html).toContain('<details');
  expect(html).toContain('characters');
  expect(html).toContain(text);
  expect(html).toContain('whitespace-pre-wrap');
});
