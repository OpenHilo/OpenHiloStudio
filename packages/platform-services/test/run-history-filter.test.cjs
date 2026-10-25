const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { listRuns } = require('../dist/run-history');
test('searchable workflow filters distinguish namespaces and preserve existing bare-name filters', async t => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ux-history-'));
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));
  for (const ns of ['one', 'two']) {
    await fs.mkdir(path.join(runsDir, ns));
    await fs.writeFile(path.join(runsDir, ns, 'run.json'), JSON.stringify({ run_id: ns, intent: 'check', workdir: '/work', status: 'completed', created_at: '2026-10-13', ittPath: `/fixture/intents/${ns}/check/check.itt.impl.json` }));
  }
  assert.deepEqual((await listRuns({ runsDir, filters: { intent: 'one.check' } })).runs.map(r => r.run_id), ['one']);
  assert.equal((await listRuns({ runsDir, filters: { intent: 'check' } })).total, 2);
  assert.equal((await listRuns({ runsDir, filters: { intent: 'three.check' } })).total, 0);
  assert.equal((await listRuns({ runsDir, filters: { intent: 'chec' } })).total, 0);
});

test('completed-on filter uses completion day, including yesterday starts and excluding noncompleted records',async t=>{
 const runsDir=await fs.mkdtemp(path.join(os.tmpdir(),'completion-day-'));t.after(()=>fs.rm(runsDir,{recursive:true,force:true}));
 const {getStats}=require('../dist/stats-service');
 const today=new Date().toISOString().slice(0,10);
 for(const [id,status,created,updated] of [['overnight','completed','2020-01-01',today],['old','completed',today,'2020-01-01'],['failed','failed',today,today]]){
  await fs.mkdir(path.join(runsDir,id));await fs.writeFile(path.join(runsDir,id,'run.json'),JSON.stringify({run_id:id,intent:'test',workdir:'/tmp',status,created_at:created+'T00:00:00.000Z',updated_at:updated+'T00:00:00.000Z'}));
 }
 const result=await listRuns({runsDir,filters:{completedOn:today,status:'completed'}});
 assert.deepEqual(result.runs.map(r=>r.run_id),['overnight']);assert.equal(result.total,(await getStats(runsDir)).completedToday);
 for(const completedOn of ['2026-02-30','invalid','2026-10'])await assert.rejects(()=>listRuns({runsDir,filters:{completedOn}}),/Invalid completion date/);
});


test('qualified history filters support nested namespaces and flat module artifacts', async t => {
 const runsDir=await fs.mkdtemp(path.join(os.tmpdir(),'nested-history-'));t.after(()=>fs.rm(runsDir,{recursive:true,force:true}));
 for(const [id,intent,ittPath] of [
  ['nested','entry','/fixture/intents/team/report/entry/entry.itt.impl.json'],
  ['flat','entry','/fixture/intents/team/report/entry.itt.impl.json'],
  ['relative','team/report/entry/entry','team/report/entry/entry.itt.impl.json'],
  ['other','entry','/fixture/intents/team/other/entry/entry.itt.impl.json'],
 ]){await fs.mkdir(path.join(runsDir,id));await fs.writeFile(path.join(runsDir,id,'run.json'),JSON.stringify({run_id:id,intent,ittPath,status:'completed',workdir:'/work',created_at:'2026-01-01'}));}
 const result=await listRuns({runsDir,filters:{intent:'team.report.entry'}});
 assert.deepEqual(result.runs.map(r=>r.run_id).sort(),['flat','nested','relative']);
 assert.equal((await listRuns({runsDir,filters:{intent:'entry'}})).total,3,'preserve historical exact bare-name filters');
});

test('history service rejects invalid paging without truncating the human inbox',async t=>{
 const runsDir=await fs.mkdtemp(path.join(os.tmpdir(),'page-history-'));t.after(()=>fs.rm(runsDir,{recursive:true,force:true}));
 for(const paging of [{page:0},{page:NaN},{limit:-1},{limit:1.5},{page:Number.MAX_SAFE_INTEGER,limit:20}])
  await assert.rejects(listRuns({runsDir,...paging}),error=>error.statusCode===400);
 assert.equal((await listRuns({runsDir,limit:Number.MAX_SAFE_INTEGER})).total,0);
});
