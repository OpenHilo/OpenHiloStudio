// Audit the distributable tree, excluding only generated local artifacts.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const ignored=new Set(['.git','node_modules','dist','coverage','test-results','playwright-report']);
const names=[];
function walk(dir) { for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
 if(ignored.has(e.name))continue;
 const file=path.join(dir,e.name),rel=path.relative(root,file);
 assert(!e.isSymbolicLink(),`Unexpected source symlink: ${rel}`);
 if(e.isDirectory()){walk(file);continue;}
 assert(!/(^|\/)(\.env(?:\..*)?|\.local-backups|promo|brain|runs|sessions)(\/|$)|\.(?:db|sqlite|mp4|mov|webm|log)$/.test(rel),`Private/generated file: ${rel}`);
 names.push(rel);
 if(/\.(?:[cm]?[jt]sx?|json|md|yml|yaml|txt|css|html)$/.test(rel)) {
  const text=fs.readFileSync(file,'utf8');
  assert(!/\/Users\/[A-Za-z0-9_.-]+\//.test(text),`Personal absolute path: ${rel}`);
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text),`Private key: ${rel}`);
  assert(!/(?:from\s+["']|require\(["'])@intentorch\//.test(text),`Private import: ${rel}`);
 }
}}
walk(root);
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));
for(const key of Object.keys(lock.packages))assert(!/node_modules\/(?:@intentorch\/|node-pty(?:\/|$))/.test(key),`Excluded dependency: ${key}`);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
assert.equal(lock.packages['node_modules/dompurify'].version,manifest.overrides.dompurify,'Root sanitizer override must be present in the lockfile');
const pin=JSON.parse(fs.readFileSync(path.join(root,'vendor/openhilo/manifest.json')));
for(const patch of pin.patches) {
 const data=fs.readFileSync(path.join(root,'vendor/openhilo',patch.file));
 assert.equal(crypto.createHash('sha256').update(data).digest('hex'),patch.sha256,patch.file);
}
for(const p of pin.packages) {
 const data=fs.readFileSync(path.join(root,'vendor/openhilo',p.file));
 assert.equal(crypto.createHash('sha256').update(data).digest('hex'),p.sha256,p.file);
 assert.equal(lock.packages['node_modules/'+p.name].integrity,'sha512-'+crypto.createHash('sha512').update(data).digest('base64'),p.name);
}
for(const name of names.filter(n=>n.endsWith('.md'))) {
 const text=fs.readFileSync(path.join(root,name),'utf8');
 for(const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
  const ref=match[1].split('#')[0];
  if(!ref||/^[a-z]+:/i.test(ref))continue;
  assert(fs.existsSync(path.resolve(root,path.dirname(name),decodeURIComponent(ref))),`Broken link ${name}: ${ref}`);
 }
}
console.log(`Audited ${names.length} distributable files and ${pin.packages.length} core archives; no legacy history/data or private package dependencies.`);
