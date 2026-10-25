// Deterministic component hook harness; tests real handlers, save calls and navigation guards.
let mockSlots: any[], mockCursor: number, mockEffects: (() => void)[], mockGuard: boolean;
let mockBlocker: any;
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: unknown) => { const i = mockCursor++; if (!(i in mockSlots)) mockSlots[i] = initial;
    return [mockSlots[i], (next: any) => { mockSlots[i] = typeof next === 'function' ? next(mockSlots[i]) : next; }]; },
  useRef: (initial: unknown) => { const i = mockCursor++; return mockSlots[i] ??= { current: initial }; },
  useEffect: (effect: () => any, deps: any[]) => { const i = mockCursor++; const old = mockSlots[i];
    if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) mockEffects.push(() => {
      old?.cleanup?.(); mockSlots[i] = { deps, cleanup: effect() };
    });
  },
}));
jest.mock('react-router-dom', () => ({ useBlocker: (guard: boolean) => { mockGuard = guard; return mockBlocker; } }));
jest.mock('../../api/config', () => ({ getConfig: jest.fn(), updateConfig: jest.fn() }));
import {SettingsPage} from '../../pages/SettingsPage';
import {renderToStaticMarkup} from 'react-dom/server';
import {AiRoutesEditor} from '../../components/AiRoutesEditor';
import {getConfig, updateConfig, type IttConfig} from '../../api/config';
import {settingsDraftKey, profileDrafts} from '../settings-draft';
const routes = {adapter:'routed',routes:{default:{defaultLevel:'medium',levels:{medium:{adapter:'codex',model:'saved-model',effort:'medium',timeout_ms:43200000}}}}} as const;
let initial: IttConfig;
function render() { mockCursor=0; mockEffects=[]; const tree=SettingsPage({}); mockEffects.forEach(run=>run()); return tree; }
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; return [tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)]; }
function routeEditor(tree: any) { return nodes(tree).find(n=>n.type===AiRoutesEditor); }
function saveButton(tree: any) { return nodes(tree).find(n=>n.type==='button' && n.props.type==='submit'); }
async function load() { render(); await Promise.resolve(); return render(); }
async function save(tree: any) { await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}}); return render(); }
beforeEach(()=>{
  mockSlots=[]; mockCursor=0; mockGuard=false;
  mockBlocker={state:'unblocked',proceed:jest.fn(),reset:jest.fn()};
  initial={ai_execution:structuredClone(routes),configuration_revision:'r1'};
  (getConfig as jest.Mock).mockImplementation(async()=>structuredClone(initial));
  (updateConfig as jest.Mock).mockReset();
  (global as any).window={addEventListener:jest.fn(),removeEventListener:jest.fn()};
});
afterEach(()=>{mockSlots.forEach(s=>s?.cleanup?.()); delete (global as any).window;});
test('read-only Codex settings display the active execution configuration',async()=>{
  initial={ai_execution:{adapter:'codex',model:'configured-model',cli_path:'/opt/bin/codex',effort:'high',sandbox:'read-only',timeout_ms:90000},configuration_status:{activation:'restart',editable:false,restart_required:false}};
  const tree=await load(), html=renderToStaticMarkup(tree);
  for(const value of ['configured-model','/opt/bin/codex','high','read-only','90000']) expect(html).toContain(value);
  expect(saveButton(tree).props.disabled).toBe(true); expect(mockGuard).toBe(false);
});
test('omitted Codex configuration explains defaults instead of hiding them',async()=>{
  initial={ai_execution:{adapter:'codex'},configuration_status:{activation:'restart',editable:false,restart_required:false}};
  const html=renderToStaticMarkup(await load());
  for(const value of ['CLI default','workspace-write','43200000','Active-time limit']) expect(html).toContain(value);
});
test('loading, repeated renders and no-op editor notifications stay clean; no-op Save sends no request',async()=>{
  let tree=await load(); expect(mockGuard).toBe(false); expect(saveButton(tree).props.disabled).toBe(true);
  routeEditor(tree).props.onChange(structuredClone(routes)); tree=render();
  expect(mockGuard).toBe(false); expect(window.addEventListener).not.toHaveBeenCalled();
  await save(tree); expect(updateConfig).not.toHaveBeenCalled();
});
test('actual nested edits protect navigation; restoring the saved model removes both guards',async()=>{
  let tree=await load(); const changed=structuredClone(routes) as any; changed.routes.default.levels.medium.model='another';
  routeEditor(tree).props.onChange(changed); tree=render();
  expect(mockGuard).toBe(true); expect(saveButton(tree).props.disabled).toBe(false);
  expect(window.addEventListener).toHaveBeenCalledWith('beforeunload',expect.any(Function));
  mockBlocker={...mockBlocker,state:'blocked'};
  routeEditor(tree).props.onChange(structuredClone(routes)); tree=render();
  expect(mockGuard).toBe(false); expect(saveButton(tree).props.disabled).toBe(true);
  expect(window.removeEventListener).toHaveBeenCalledWith('beforeunload',expect.any(Function));
  expect(mockBlocker.proceed).toHaveBeenCalledTimes(1);
});
test('saved pending routes are the baseline, even while the server uses older routes',async()=>{
  initial.saved_ai_execution=structuredClone(routes);
  initial.ai_execution={...routes,routes:{default:{...routes.routes.default,levels:{medium:{adapter:'codex',model:'old-active'}}}}};
  const tree=await load(); expect(routeEditor(tree).props.value).toEqual(routes);
  expect(mockGuard).toBe(false); expect(saveButton(tree).props.disabled).toBe(true);
});
test('failed saves retain protection; successful saves adopt the returned baseline and permit pending navigation',async()=>{
  let tree=await load(); const changed=structuredClone(routes) as any; changed.routes.default.levels.medium.effort='high';
  routeEditor(tree).props.onChange(changed); tree=render();
  (updateConfig as jest.Mock).mockRejectedValueOnce(new Error('Save failed'));
  tree=await save(tree); expect(mockGuard).toBe(true); expect(saveButton(tree).props.disabled).toBe(false);
  mockBlocker={...mockBlocker,state:'blocked'};
  (updateConfig as jest.Mock).mockResolvedValueOnce({...initial,saved_ai_execution:changed,configuration_revision:'r2'});
  tree=await save(tree); expect(mockGuard).toBe(false); expect(saveButton(tree).props.disabled).toBe(true);
  expect(mockBlocker.proceed).toHaveBeenCalledTimes(1);
  routeEditor(tree).props.onChange(structuredClone(changed)); render(); expect(mockGuard).toBe(false);
});
test('route key ordering is irrelevant; actual additions, removals and type changes remain dirty',()=>{
 const key=(v:unknown)=>settingsDraftKey('routed',v,[],'',undefined);
 const reordered={routes:routes.routes,adapter:'routed'}; expect(key(reordered)).toBe(key(routes));
 expect(key({...routes,routes:{...routes.routes,coding:routes.routes.default}})).not.toBe(key(routes));
 expect(key({...routes,routes:{}})).not.toBe(key(routes));
 expect(settingsDraftKey('sdk',routes,[],'',undefined)).not.toBe(key(routes));
});
test('SDK comparison follows saved normalization, including restored values and numeric token input',()=>{
 const profiles=profileDrafts({adapter:'sdk',default_profile:'main',profiles:{main:{provider:'openai',model:'model',api_key_env:'KEY',max_output_tokens:100}}});
 const key=(p:typeof profiles)=>settingsDraftKey('sdk',undefined,p,'main',undefined);
 expect(key([{...profiles[0],model:' model ',maxTokens:'100.0'}])).toBe(key(profiles));
 expect(key([{...profiles[0],model:'different'}])).not.toBe(key(profiles));
 expect(key([{...profiles[0],maxTokens:''}])).not.toBe(key(profiles));
 expect(settingsDraftKey('custom',undefined,[],'',{mode:'a',other:true})).toBe(settingsDraftKey('custom',undefined,[],'',{other:true,mode:'a'}));
});
