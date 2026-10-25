// Installs real archives into separate temporary projects. Never uses source links.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-consumers-')));
const archives = path.join(output, 'archives'); fs.mkdirSync(archives);
const cacheIndex = process.argv.indexOf('--cache');
const cache = cacheIndex < 0 ? path.join(output, 'npm-cache') : path.resolve(process.argv[cacheIndex + 1]);
const npmFlags = ['--cache', cache, ...(process.argv.includes('--offline') ? ['--offline'] : [])];
const lockedDependencies = process.argv.includes('--locked-dependencies');
if (lockedDependencies && !process.argv.includes('--offline')) throw new Error('--locked-dependencies is an offline verification mode');
const packages = new Map();
for (const group of ['packages', 'adapters', 'apps']) for (const name of fs.readdirSync(path.join(root, group))) {
  const directory = path.join(root, group, name), file = path.join(directory, 'package.json');
  if (fs.existsSync(file)) { const manifest = JSON.parse(fs.readFileSync(file)); packages.set(manifest.name, { directory, manifest }); }
}
// Core is consumed as the same immutable archives used by Studio.
const corePin = require('../vendor/openhilo/manifest.json');
for (const pkg of corePin.packages) {
  const directory = path.join(root, 'node_modules', pkg.name);
  packages.set(pkg.name, { directory, manifest: JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))), archive: path.join(root, 'vendor/openhilo', pkg.file) });
}
const packageName = name => '@openhilo/' + name;
const record = { source: root, node: process.version, platform: process.platform, arch: process.arch, archives: [], scenarios: [] };
record.dependencyResolution = lockedDependencies ? 'cached workspace-lock tarballs; no registry version resolution' : 'consumer manifest resolution';
const reportFile = path.join(output, 'results.json');
function save() { fs.writeFileSync(reportFile, JSON.stringify(record, null, 2) + '\n'); }
function command(bin, args, cwd, label, env = process.env) {
  const log = path.join(output, label + '.log');
  const fd = fs.openSync(log, 'w');
  const result = spawnSync(bin, args, { cwd, env, timeout: 600_000, stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
  if (result.error || result.status !== 0) throw new Error(`${label} failed: ${result.error?.message ?? result.status ?? result.signal}; see ${log}`);
  return fs.readFileSync(log, 'utf8');
}
function internalClosure(seeds) {
  const found = new Set();
  function visit(name) {
    if (found.has(name)) return;
    const entry = packages.get(name); assert.ok(entry, `Unknown workspace ${name}`); found.add(name);
    for (const dependency of Object.keys(entry.manifest.dependencies || {})) if ((dependency.startsWith('@intentorch/') || dependency.startsWith('@openhilo/'))) visit(dependency);
  }
  seeds.forEach(visit); return [...found].sort();
}
const scenarios = [
 {name:'generic',seeds:['server','code-local','studio'],forbidden:['@intentorch','@openhilo/ai-sdk','openai','@anthropic-ai/sdk','node-pty'],tests:['apps/server/test/offline-demo.test.cjs','apps/server/test/server.test.cjs']},
 {name:'codex',seeds:['server','code-local','ai-codex'],forbidden:['@intentorch','@openhilo/ai-sdk','openai','@anthropic-ai/sdk','node-pty'],tests:['apps/server/test/codex-local.test.cjs'],fixtures:['tests/fixtures/protocol-peer.cjs']},
 {name:'sdk',seeds:['server','code-local','ai-sdk'],forbidden:['@intentorch','node-pty'],tests:['apps/server/test/sdk-local.test.cjs']},
 {name:'routed',seeds:['server','code-local','ai-codex','ai-sdk'],forbidden:['@intentorch','node-pty'],tests:['apps/server/test/routed-preset.test.cjs'],fixtures:['tests/fixtures/protocol-peer.cjs']},
];

console.log(`Independent consumer verification: ${output}`);
try {
  for (const [name, entry] of packages) {
    if (entry.archive) {
      record.archives.push({ name, version: entry.manifest.version, filename: path.basename(entry.archive), sha256: crypto.createHash('sha256').update(fs.readFileSync(entry.archive)).digest('hex') });
      continue;
    }
    const [packed] = JSON.parse(command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', archives, ...npmFlags], entry.directory, 'pack-' + name.split('/')[1]));
    entry.archive = path.join(archives, packed.filename);
    record.archives.push({ name, version: entry.manifest.version, filename: packed.filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(entry.archive)).digest('hex'), integrity: packed.integrity });
  }
  save();
  for (const scenario of scenarios) {
    console.log(`Checking ${scenario.name}...`);
    const directory = path.join(output, scenario.name); fs.mkdirSync(directory);
    const home = path.join(directory, 'temporary-home'); fs.mkdirSync(home);
    const names = internalClosure(scenario.seeds.map(packageName));
    const dependencies = Object.fromEntries(names.map(name => [name, 'file:' + packages.get(name).archive]));
    if (!['core', 'human'].includes(scenario.name)) dependencies['node-cron'] = '4.6.0';
    // Keep the compiler and Node declarations available for public consumer types.
    const manifest = { overrides: {dompurify: '3.4.17'}, name: 'openhilo-studio-consumer-' + scenario.name, version: '1.0.0', private: true, dependencies, devDependencies: { '@types/node': '22.19.15', typescript: '5.9.3' } };
    if (lockedDependencies) {
      // Tarballs can be cached even when npm's version index is stale. This mode
      // validates real independent archives against the audited workspace lock;
      // it does not claim a fresh registry resolution was tested.
      const locked = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))).packages;
      if (dependencies['node-cron']) dependencies['node-cron'] = locked['node_modules/node-cron'].resolved;
      for (const name of names) for (const dependency of Object.keys(packages.get(name).manifest.dependencies || {})) {
        if ((dependency.startsWith('@intentorch/') || dependency.startsWith('@openhilo/'))) continue;
        const relative = path.relative(root, packages.get(name).directory);
        const entry = locked[relative + '/node_modules/' + dependency] || locked['node_modules/' + dependency];
        assert.ok(entry?.resolved?.startsWith('https://registry.npmjs.org/'), 'Missing locked tarball: ' + dependency);
        dependencies[dependency] = entry.resolved;
      }
      const byName = new Map();
      for (const [key, entry] of Object.entries(locked)) {
        if (!key.includes('node_modules/') || !entry.resolved?.startsWith('https://registry.npmjs.org/')) continue;
        const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (!byName.has(name)) byName.set(name, new Map());
        byName.get(name).set(entry.version, entry.resolved);
      }
      manifest.overrides = {};
      for (const [name, versions] of byName) {
        if (versions.size === 1 && !dependencies[name] && !manifest.devDependencies[name]) manifest.overrides[name] = [...versions.values()][0];
      }
      // The compatibility tree also contains node-addon-api 7. SQLite 13 needs
      // its own locked major rather than npm's older cached major-8 index.
      if (dependencies['better-sqlite3']) manifest.overrides['better-sqlite3'] = {
        '.': dependencies['better-sqlite3'], 'node-addon-api': locked['node_modules/better-sqlite3/node_modules/node-addon-api'].resolved,
      };
    }
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, INTENTORCH_HOME: path.join(home, 'data'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'OpenHilo Test', GIT_AUTHOR_EMAIL: 'offline@localhost', GIT_COMMITTER_NAME: 'OpenHilo Test', GIT_COMMITTER_EMAIL: 'offline@localhost' };
    command('npm', ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', ...npmFlags], directory, scenario.name + '-install', env);
    for (const name of names) {
      const installed = path.join(directory, 'node_modules', name);
      assert.equal(fs.realpathSync(installed), installed, `${scenario.name}: ${name} is a source link`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'))).version, packages.get(name).manifest.version);
    }
    if (names.includes('@openhilo/studio')) assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'node_modules/dompurify/package.json'))).version, '3.4.17', 'Consumer sanitizer override was not applied');
    for (const name of scenario.forbidden) assert.equal(fs.existsSync(path.join(directory, 'node_modules', name)), false, `${scenario.name}: forbidden package installed: ${name}`);
    if (names.includes('@openhilo/platform-services')) {
      // SQLite 13 ships Node-API binaries in its archive; exercise the installed
      // binding directly, including with lifecycle scripts disabled.
      command(process.execPath, ['-e', `const Database = require('better-sqlite3'); const db = new Database(':memory:'); console.log(JSON.stringify({ version: require('better-sqlite3/package.json').version, sqlite: db.prepare('select sqlite_version() as version').get().version })); db.close();`], directory, scenario.name + '-native-check', env);
    }
    const guard = path.join(directory, 'offline-guard.cjs'); fs.copyFileSync(path.join(root, 'scripts/offline-guard.cjs'), guard);
    const testEnv = { ...env, NODE_OPTIONS: `--require=${JSON.stringify(guard)}` };
    for (const fixture of scenario.fixtures || []) {
      const target = path.join(directory, 'fixtures', path.basename(fixture)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, fixture), target); fs.chmodSync(target, fs.statSync(path.join(root, fixture)).mode & 0o777);
    }
    const tests = [];
    for (const [index, file] of (scenario.tests || []).entries()) {
      const target = path.join(directory, `${index}-${path.basename(file)}`); fs.copyFileSync(path.join(root, file), target); tests.push(target);
    }
    if (tests.length) command(process.execPath, ['--test', '--test-concurrency=1', ...tests], directory, scenario.name + '-tests', testEnv);
    for (const [index, example] of (scenario.examples || []).entries()) {
      command(process.execPath, example.map(file => path.join(directory, 'node_modules', '@openhilo', file)), directory, `${scenario.name}-example-${index}`, testEnv);
    }
    const contract = names.map((name, index) => `import * as M${index} from '${name}';\nexport type Public${index} = typeof M${index};`).join('\n');
    fs.writeFileSync(path.join(directory, 'public-contract.ts'), contract);
    const typeFiles = ['public-contract.ts'];
    if (names.includes('@openhilo/server')) for (const file of fs.readdirSync(path.join(root, 'apps/server/test')).filter(file => file.endsWith('-contract.ts'))) {
      fs.copyFileSync(path.join(root, 'apps/server/test', file), path.join(directory, file)); typeFiles.push(file);
    }
    command(process.execPath, [path.join(directory, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'Node16', '--moduleResolution', 'Node16', ...typeFiles], directory, scenario.name + '-types', testEnv);
    record.scenarios.push({ name: scenario.name, packages: names, forbiddenPackagesAbsent: scenario.forbidden, tests: scenario.tests || [], examples: scenario.examples || [], publicTypes: typeFiles, passed: true }); save();
  }
  console.log(`All ${scenarios.length} independent consumers passed; archives, logs and results: ${output}`);
} catch (error) { record.failure = error.message; save(); console.error(error.message); process.exitCode = 1; }
