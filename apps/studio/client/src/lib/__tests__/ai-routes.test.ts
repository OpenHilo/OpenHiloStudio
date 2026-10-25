import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AiRoutesEditor} from '../../components/AiRoutesEditor';
import {setRouteCell, validateRoutes, type RoutedExecutionConfig} from '../ai-routes';
const config: RoutedExecutionConfig = {adapter:'routed',routes:{default:{defaultLevel:'medium',levels:{medium:{adapter:'codex',model:'general-model',effort:'medium',cli_path:'/configured/codex',timeout_ms:43200000}}},coding:{defaultLevel:'pro',levels:{light:{adapter:'codex',model:'small'},pro:{adapter:'codex',model:'coding-model',effort:'high'}}}}};
test('model edits preserve other levels and host paths without mutating the active configuration',()=>{
 const changed=setRouteCell(config,'coding','pro',{model:'updated'});
 expect(changed.routes.coding!.levels.pro).toMatchObject({model:'updated',effort:'high'});
 expect(changed.routes.default).toEqual(config.routes.default);expect(config.routes.coding!.levels.pro).toMatchObject({model:'coding-model'});
 expect(validateRoutes(changed)).toBeUndefined();
});
test('invalid default levels, timeout and effort cannot be saved',()=>{
 expect(validateRoutes({...config,routes:{default:{defaultLevel:'max',levels:{medium:{adapter:'codex'}}}}})).toMatch(/defaultLevel/);
 expect(validateRoutes(setRouteCell(config,'default','medium',{timeout_ms:0}))).toMatch(/timeout/);
 expect(validateRoutes(setRouteCell(config,'default','medium',{effort:'max' as 'high'}))).toMatch(/effort/);
});
test('each type and level has a native disclosure, editable labeled fields and default selection',()=>{
 const html=renderToStaticMarkup(createElement(AiRoutesEditor,{value:config,onChange:()=>{}}));
 expect((html.match(/<details/g)||[]).length).toBe(10);
 expect(html).toContain('Model for coding/pro');expect(html).toContain('Reasoning for coding/pro');
 expect(html).toContain('Default level for coding');expect(html).toContain('Add level to coding');
 expect(html).toContain('coding-model');expect(html).toContain('Advanced');
 expect(html).not.toContain('Remove default type');
});
