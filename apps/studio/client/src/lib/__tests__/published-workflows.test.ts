import {publishedWorkflows} from '../published-workflows';
test('published entries retain namespaces and all entry exports',()=>{
 expect(publishedWorkflows({phase:'done',savedPath:'/intents',savedPaths:['/intents/team/module/start'],entries:['team/module/start','team/module/report','team/module/start']})).toEqual(['team.module.start','team.module.report']);
});
test('older publication receipts use exact saved paths, never an ambiguous basename',()=>{
 expect(publishedWorkflows({phase:'done',savedPath:'/intents',savedPaths:['/intents/team/entry','/elsewhere/team/entry']})).toEqual(['team.entry']);
 expect(publishedWorkflows({phase:'done',savedPath:'',savedPaths:[]})).toEqual([]);
 expect(publishedWorkflows({phase:'done',savedPath:'/intents',entries:['../escape','/absolute','okay/entry']})).toEqual(['okay.entry']);
});
