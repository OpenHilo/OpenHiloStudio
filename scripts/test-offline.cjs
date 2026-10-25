// Scripted providers and disposable homes only. This guard is not an OS sandbox.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'studio-test-'));
const guard = path.join(root, 'scripts/offline-guard.cjs');
const env = {...process.env, HOME:scratch, USERPROFILE:scratch, TMPDIR:scratch, TMP:scratch, TEMP:scratch,
  INTENTORCH_HOME:path.join(scratch,'data'), NODE_ENV:'test', INTENTORCH_LIVE_OAUTH_PROBE:'0',
  GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_SYSTEM:'/dev/null', GIT_AUTHOR_NAME:'Studio Test',
  GIT_AUTHOR_EMAIL:'test@localhost', GIT_COMMITTER_NAME:'Studio Test', GIT_COMMITTER_EMAIL:'test@localhost',
  NODE_OPTIONS:`--require=${JSON.stringify(guard)}`};
function run(args) {
 const result=spawnSync(process.execPath,args,{cwd:root,env,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(`Test process failed (${result.status ?? result.signal})`);
}
try {
 const files=[];
 for(const group of ['packages','adapters','apps'])for(const name of fs.readdirSync(path.join(root,group))) {
  const dir=path.join(group,name,'test');
  if(fs.existsSync(path.join(root,dir)))files.push(...fs.readdirSync(path.join(root,dir)).filter(f=>f.endsWith('.test.cjs')).map(f=>path.join(dir,f)));
 }
 files.push(...fs.readdirSync(path.join(root,'tests/integration')).filter(f=>f.endsWith('.test.cjs')).map(f=>path.join('tests/integration',f)));
 console.log(`Running ${files.length} module and integration files in a disposable home.`);
 run(['--test','--test-concurrency=1',...files.sort()]);
 run([require.resolve('jest/bin/jest'),'--config','jest.config.cjs','--runInBand']);
} catch(error) {console.error(error);process.exitCode=1;}
finally {fs.rmSync(scratch,{recursive:true,force:true});}
