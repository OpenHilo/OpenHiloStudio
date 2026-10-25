const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const posix = path.posix;

function dependencyEdges(manifest) {
  const names = new Set([...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.optionalDependencies || {}), ...Object.keys(manifest.peerDependencies || {})]);
  return [...names].sort().map(name => ({ name, optional: Object.hasOwn(manifest.optionalDependencies || {}, name) || (!Object.hasOwn(manifest.dependencies || {}, name) && manifest.peerDependenciesMeta?.[name]?.optional === true) }));
}
function resolveDependency(packages, from, name) {
  let base = from;
  while (true) {
    const candidate = posix.join(base, 'node_modules', name);
    if (packages[candidate]) {
      const entry = packages[candidate];
      if (!entry.link) return candidate;
      assert.ok(packages[entry.resolved], `Missing workspace target: ${candidate}`);
      return entry.resolved;
    }
    if (!base || base === '.') return undefined;
    base = posix.dirname(base); if (base === '.') base = '';
  }
}
function closure(packages, starts, stopAt = () => false) {
  const included = new Set(), absentOptional = [];
  function visit(key) {
    if (included.has(key)) return;
    const entry = packages[key]; assert.ok(entry, `Missing lock entry: ${key}`); included.add(key);
    if (stopAt(key)) return;
    for (const edge of dependencyEdges(entry)) {
      const resolved = resolveDependency(packages, key, edge.name);
      if (resolved !== undefined) visit(resolved);
      else if (edge.optional) absentOptional.push({ from: key, name: edge.name });
      else throw new Error(`Unresolved required dependency ${edge.name} from ${key}`);
    }
  }
  starts.forEach(visit);
  return { keys: [...included].sort(), absentOptional };
}
function licenseFiles(directory, relative = '') {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink()) return [];
    const name = posix.join(relative, entry.name);
    if (entry.isDirectory()) return licenseFiles(directory, name);
    return /^(licen[cs]e|copying|notice|copyright|third.?party.?notices)(\b|[._-])/i.test(entry.name) && !/\.(js|ts|map|json)$/.test(entry.name) ? [name] : [];
  });
}
function externalName(key, entry) { return entry.name || key.slice(key.lastIndexOf('node_modules/') + 13); }

function generate(root) {
  const overridesFile = path.join(root, 'docs/open-source/third-party-sources/index.json');
  const overrides = fs.existsSync(overridesFile) ? json(overridesFile) : {};
  const rootLock = json(path.join(root, 'package-lock.json'));
  const folders = Object.keys(rootLock.packages).filter(key => key && !key.includes('node_modules') && fs.existsSync(path.join(root, key, 'package.json'))).sort();
  const collections = [], outputs = new Map(), cache = new Map();
  const inventory = { formatVersion: 1, scope: 'Root lockfile; license texts for runtime dependency closures and Studio build helpers. Optional peers absent from locks are recorded, not installed.', locks: [], packages: [] };
  function record(lockDirectory, key, entry) {
    const id = `${lockDirectory}:${key}`; if (cache.has(id)) return cache.get(id);
    const name = externalName(key, entry), directory = path.join(root, lockDirectory, key);
    const manifest = json(path.join(directory, 'package.json'));
    assert.equal(manifest.name, name, `${id}: installed package name`);
    assert.equal(manifest.version, entry.version, `${id}: installed version differs from lock`);
    const texts = licenseFiles(directory).map(file => ({ source: `${name}@${entry.version}/${file}`, content: fs.readFileSync(path.join(directory, file), 'utf8') }));
    for (const addition of overrides[`${name}@${entry.version}`] || []) {
      const content = fs.readFileSync(path.join(root, 'docs/open-source/third-party-sources', addition.file), 'utf8');
      assert.equal(sha256(content), addition.sha256, `${name}: upstream license hash changed`);
      texts.push({ source: addition.url, note: addition.note, content });
    }
    assert.ok(texts.length, `${name}@${entry.version}: no license text; add a reviewed, version-bound upstream source`);
    const value = { name, version: entry.version, license: entry.license ?? manifest.license ?? null, integrity: entry.integrity ?? null, texts };
    cache.set(id, value); return value;
  }
  function render(records, title) {
    const unique = new Map();
    for (const r of records) {
      const identity = `${r.name}@${r.version}`;
      if (unique.has(identity)) assert.deepEqual(unique.get(identity).texts, r.texts, `${identity}: different contents across lockfiles`);
      else unique.set(identity, r);
    }
    const sorted = [...unique.values()].sort((a,b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
    return `THIRD-PARTY NOTICES — ${title}\n\nGenerated by scripts/third-party-notices.cjs. Preserve this file when redistributing.\nThis is a conservative dependency inventory, not a claim that every listed file is bundled.\nEach component retains its own license; OpenHilo Studio's MIT license does not relicense it.\nRuntime dependency closures include optional peers present in the lockfile.\nStudio additionally includes notices for its build helpers and embedded upstream resources.\n\n` + (sorted.length ? sorted.map(r => `================================================================================\n${r.name}@${r.version}\nDeclared license: ${typeof r.license === 'string' ? r.license : JSON.stringify(r.license)}\nIntegrity: ${r.integrity ?? 'not recorded'}\n\n` + r.texts.map(t => `--- ${t.source} ---\n${t.note ? t.note + '\n' : ''}SHA-256: ${sha256(t.content)}\n\n${t.content}${t.content.endsWith('\n') ? '' : '\n'}`).join('\n')).join('\n') : 'No external runtime dependencies in this package closure.\n');
  }
  for (const lockDirectory of ['']) {
    const lockPath = posix.join(lockDirectory, 'package-lock.json'), lock = json(path.join(root, lockPath));
    inventory.locks.push({ path: lockPath, sha256: sha256(fs.readFileSync(path.join(root, lockPath))) });
    // platform's local file dependencies resolve outside that lock's root. Their
    // external dependencies are already inventoried through the root workspaces.
    const starts = lockDirectory ? [''] : ['', ...folders];
    for (const key of starts) {
      const manifest = json(path.join(root, lockDirectory, key, 'package.json'));
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
        assert.deepEqual(manifest[field] || {}, lock.packages[key]?.[field] || {}, `${posix.join(lockDirectory, key)}: ${field} differs from lock`);
      }
    }
    if (lockDirectory === 'platform') {
      for (const [key, entry] of Object.entries(lock.packages).filter(([key]) => key.startsWith('../'))) {
        const target = key.slice(3);
        assert.ok(rootLock.packages[target] && (folders.includes(target) || target.startsWith('node_modules/@openhilo/')), `External dependency is absent from root inventory: ${key}`);
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
          assert.deepEqual(entry[field] || {}, rootLock.packages[target][field] || {}, `${key}: workspace dependency metadata differs between locks`);
        }
      }
    }
    const graph = closure(lock.packages, starts, key => lockDirectory === 'platform' && key.startsWith('../'));
    const records = graph.keys.filter(key => key.includes('node_modules/') && !lock.packages[key].link).map(key => record(lockDirectory, key, lock.packages[key]));
    collections.push(...records);
    inventory.locks.at(-1).absentOptional = graph.absentOptional;
    for (const [key, entry] of Object.entries(lock.packages).sort(([a],[b]) => a.localeCompare(b, 'en'))) {
      if (!key.includes('node_modules/') || entry.link) continue;
      const found = cache.get(`${lockDirectory}:${key}`);
      inventory.packages.push({ lock: lockPath, path: key, name: externalName(key, entry), version: entry.version, license: entry.license ?? null, integrity: entry.integrity ?? null, dev: !!entry.dev, optional: !!entry.optional, runtime: graph.keys.includes(key), texts: found?.texts.map(t => ({ source: t.source, sha256: sha256(t.content), ...(t.note ? { note: t.note } : {}) })) ?? [] });
    }
  }
  for (const folder of folders) {
    const manifest = json(path.join(root, folder, 'package.json'));
    const graph = closure(rootLock.packages, [folder]);
    const keys = graph.keys.filter(key => key.includes('node_modules/') && !rootLock.packages[key].link);
    if (manifest.name === '@openhilo/studio') {
      for (const helper of ['vite', 'rollup', '@vitejs/plugin-react', '@tailwindcss/vite']) {
        const key = resolveDependency(rootLock.packages, folder, helper); assert.ok(key, `Missing Studio helper ${helper}`); keys.push(key);
      }
    }
    const records = keys.map(key => record('', key, rootLock.packages[key]));
    collections.push(...records);
    const notice = render(records, manifest.name);
    outputs.set(`${folder}/THIRD_PARTY_NOTICES.txt`, notice);
    if (manifest.name === '@openhilo/studio') {
      const escaped = notice.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      outputs.set(`${folder}/THIRD_PARTY_NOTICES.html`, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenHilo Studio third-party notices</title></head><body><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escaped}</pre></body></html>\n`);
    }
  }
  // Include helper text references that were collected after the lock inventory.
  for (const row of inventory.packages) {
    const lockDirectory = row.lock === 'package-lock.json' ? '' : 'platform';
    const found = cache.get(`${lockDirectory}:${row.path}`);
    if (found) row.texts = found.texts.map(t => ({ source: t.source, sha256: sha256(t.content), ...(t.note ? { note: t.note } : {}) }));
  }
  outputs.set('THIRD_PARTY_NOTICES.txt', render(collections, 'OpenHilo Studio runtime dependencies'));
  outputs.set('docs/open-source/third-party-inventory.json', JSON.stringify(inventory, null, 2) + '\n');
  return outputs;
}
module.exports = { dependencyEdges, resolveDependency, closure, licenseFiles, generate };
