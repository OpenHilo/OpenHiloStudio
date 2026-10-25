const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('publication privacy guard scans archives, refuses escapes and never prints matching secrets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.resolve(__dirname, '../../scripts/audit-publication.py'), path.join(root, 'scripts/audit-publication.py'));
  const run = () => spawnSync('python3', ['scripts/audit-publication.py'], { cwd: root, encoding: 'utf8' });
  assert.equal(run().status, 0);
  const fakeToken = ['sk', 'A'.repeat(30)].join('-');
  fs.writeFileSync(path.join(root, 'fixture.txt'), fakeToken);
  let result = run();
  assert.equal(result.status, 1); assert.match(result.stdout, /credential-pattern/);
  assert.equal(result.stdout.includes(fakeToken), false);
  fs.unlinkSync(path.join(root, 'fixture.txt'));
  const makeArchive = (name, body) => {
    const result = spawnSync('python3', ['-c', `import io,tarfile,sys\nwith tarfile.open('fixture.tgz','w:gz') as t:\n b=sys.argv[2].encode(); m=tarfile.TarInfo(sys.argv[1]); m.size=len(b); t.addfile(m,io.BytesIO(b))`, name, body], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  makeArchive('package/data.txt', fakeToken);
  result = run(); assert.equal(result.status, 1); assert.match(result.stdout, /fixture.tgz!package\/data.txt/);
  assert.equal(result.stdout.includes(fakeToken), false);
  makeArchive('../escape', 'synthetic'); assert.match(run().stdout, /unsafe archive member/);
  makeArchive('package/.env', 'synthetic'); assert.match(run().stdout, /private or runtime file/);
  fs.unlinkSync(path.join(root, 'fixture.tgz'));
  fs.symlinkSync(path.join(root, 'scripts'), path.join(root, 'linked'));
  assert.match(run().stdout, /unexpected source symlink/);
});


for(const encoding of ['nul','utf16le','utf16be','tracked-ignored','duplicate-archive','special-archive','runtime-file'])
test(`publication privacy guard rejects ${encoding} blind spots`,t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'publication-edge-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'scripts'));fs.copyFileSync(path.resolve(__dirname,'../../scripts/audit-publication.py'),path.join(root,'scripts/audit-publication.py'));
 const secret=['sk','Z'.repeat(30)].join('-');
 if(encoding==='nul')fs.writeFileSync(path.join(root,'opaque.bin'),Buffer.from('\0'+secret));
 if(encoding.startsWith('utf16')){
  let bytes=Buffer.from('\ufeff'+secret,'utf16le');if(encoding==='utf16be')bytes=bytes.swap16();
  fs.writeFileSync(path.join(root,'encoded.txt'),bytes);
 }
 if(encoding==='tracked-ignored'){
  fs.mkdirSync(path.join(root,'node_modules'));fs.writeFileSync(path.join(root,'node_modules','fixture.txt'),'synthetic');
  assert.equal(spawnSync('git',['init'],{cwd:root}).status,0);
  assert.equal(spawnSync('git',['add','--','node_modules/fixture.txt'],{cwd:root}).status,0);
 }
 if(encoding==='runtime-file')fs.writeFileSync(path.join(root,'private.sqlite3'),'synthetic');
 if(encoding.endsWith('-archive')){
  const code=encoding==='duplicate-archive'
   ? "import tarfile,io\nwith tarfile.open('fixture.tgz','w:gz') as t:\n for _ in range(2):\n  m=tarfile.TarInfo('package/duplicate');m.size=1;t.addfile(m,io.BytesIO(b'x'))"
   : "import tarfile\nwith tarfile.open('fixture.tgz','w:gz') as t:\n m=tarfile.TarInfo('package/fifo');m.type=tarfile.FIFOTYPE;t.addfile(m)";
  assert.equal(spawnSync('python3',['-c',code],{cwd:root}).status,0);
 }
 const result=spawnSync('python3',['scripts/audit-publication.py'],{cwd:root,encoding:'utf8'});
 assert.equal(result.status,1,result.stdout+result.stderr);assert.equal(result.stdout.includes(secret),false);
});
