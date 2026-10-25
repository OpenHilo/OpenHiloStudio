const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { compileProgram } = require('@openhilo/compiler');
const { createTaskExecution } = require('@openhilo/ai-contracts');
const { initializeLocalHome } = require('@openhilo/server/local-initialize');
const { createLocalDeployment } = require('@openhilo/server/local-deployment');
const { createGenerationPipeline } = require('@openhilo/platform-services/generation-pipeline');
const { WorktreePool } = require('@openhilo/platform-services/worktree-pool');
const { readArtifactTree, git } = require('@openhilo/platform-services/publication');
const { extractHumanNodeInfo } = require('@openhilo/platform-services/human-history');
const files = {
  'main.ts': `import { left as l, right$ as r } from './numbers';
import { left as other } from './other';
declare function write_by_code(lang: 'bash', script: string, inputs: { content: number }): Promise<{}>;
/** @entry
 */
export async function main(): Promise<{ total: number }> {
  const { value: a } = await l();
  const { value: b } = await r();
  const { value: c } = await other();
  const total: number = a + b + c;
  await write_by_code('bash', 'printf "%s" "$content" > total.txt', { content: total });
  return { total };
}`,
  'numbers.ts': `export async function left(): Promise<{ value: number }> { return { value: 10 }; }
export async function right$(): Promise<{ value: number }> { return { value: 20 }; }`,
  'other.ts': `declare function review_by_human(prompt: string): Promise<{ approved: boolean }>;
export async function left(): Promise<{ value: number }> {
  const { approved } = await review_by_human('Approve calculation?');
  if (approved) { return { value: 30 }; }
  return { value: 0 };
}`,
};
function initialize(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'module-publication-'))), home = path.join(root, 'data');
  initializeLocalHome({ home, configuration: { format: 'intentorch.deployment', version: 1, core: { legacyFields: {} },
    domain: { selection: { id: 'generic', version: 1 }, applications: {} }, ai: { execution: { adapter: 'fixture' }, implementations: {} }, legacy: {} } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, brainDir: path.join(home, 'brain'), intentsDir: path.join(home, 'intents') };
}
function writeSources(worktree, selected = files) { for (const [file, source] of Object.entries(selected)) fs.writeFileSync(path.join(worktree, file), source); }

test(`generic module publication preserves multi-export calls, duplicate basenames, maps and cross-process nested recovery`, { timeout: 20000 }, async t => {
  const f = initialize(t); let starts = 0, host;
  const aiExecutor = { id: 'offline.module-publication', capabilities: ['structured_output', 'workspace', 'questions', 'tools'],
    async start(request, executionHost) { return createTaskExecution(request, executionHost, async () => {
      starts++; writeSources(fileURLToPath(executionHost.workspace.uri));
      return { status: 'completed', outputs: { entries: ['main/main'] }, artifacts: [] };
    }); },
  };
  const open = () => createLocalDeployment({ home: f.home, aiExecutor,
    clock: { validate: () => true, schedule() { throw new Error('No schedules'); } }, launch() { throw new Error('Standalone runtime below'); },
    configuration: { read: () => ({}), update() { throw new Error('Not used'); } },
    generation: { poolSize: 1, compileProgram },
  });
  try {
    host = await open();
    const generated = await host.generation.start({ naturalLanguage: 'Calculate three independent numbers' });
    assert.equal(generated.step.phase, 'cc_running');
    await host.generation.drain();
    assert.equal((await host.generation.read(generated.sessionId)).phase, 'confirm_merge');
    assert.deepEqual(fs.readdirSync(f.intentsDir), []);
    await host.close(); host = await open();
    const restoredReview = await host.generation.read(generated.sessionId);
    const revalidated = await host.generation.respond(generated.sessionId, { type: 'merge_approve', reviewId: restoredReview.reviewId });
    assert.equal(revalidated.phase, 'confirm_merge');
    assert.notEqual(revalidated.reviewId, restoredReview.reviewId);
    assert.deepEqual(fs.readdirSync(f.intentsDir), []);
    assert.equal((await host.generation.respond(generated.sessionId, { type: 'merge_approve', reviewId: revalidated.reviewId })).phase, 'done');
    assert.equal(starts, 1);
    for (const [file, source] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(f.brainDir, file), 'utf8'), source);
    const read = (id, suffix) => JSON.parse(fs.readFileSync(path.join(f.intentsDir, id.replaceAll('.', '/'), id.split('.').at(-1) + suffix), 'utf8'));
    const main = read('main.main', '.itt.impl.json');
    assert.deepEqual(Object.values(main.nodes).filter(node => node.executor === 'intent').map(node => node.callee).sort(), ['numbers.left', 'numbers.right$', 'other.left']);
    for (const id of ['main.main', 'numbers.left', 'numbers.right$', 'other.left']) {
      const artifact = read(id, '.itt.impl.json'), map = read(id, '.source-map.json');
      assert.equal(artifact.level, undefined);
      assert.equal(map.file, artifact.sourceFile);
      assert.equal(map.sourceTs, 'sha256:' + createHash('sha256').update(files[map.file]).digest('hex'));
      for (const node of Object.values(artifact.nodes)) assert.ok(files[map.file].slice(map.nodes[node.id].start, map.nodes[node.id].end).trim());
    }
    const child = path.join(f.root, 'runtime.cjs');
    fs.writeFileSync(child, `
      const path=require('node:path');
      const {startRun,resumeRun}=require(${JSON.stringify(require.resolve('@openhilo/runtime/run-service'))});
      const {createDispatcher}=require(${JSON.stringify(require.resolve('@openhilo/runtime/dispatcher'))});
      const {createCodeExecutor}=require(${JSON.stringify(require.resolve('@openhilo/code-local'))});
      const {Snapshotter}=require(${JSON.stringify(require.resolve('@openhilo/platform-services/brain-snapshot'))});
      const home=${JSON.stringify(f.home)},entryFile=path.join(home,'intents/main/main/main.itt.impl.json');
      const extensions=[];
      const createResources=context=>({executor:createDispatcher({codeExecutor:createCodeExecutor(context.workdir),workdir:context.workdir})});
      const operation=process.argv[2]==='start'
        ? startRun({intent:'main/main',entryFile,runsDir:path.join(home,'runs'),workdir:path.join(home,'workspaces/result'),inputs:{},humanMode:'suspend',
          extensions,createResources,populateSnapshot:context=>new Snapshotter({ittHome:home,entryFile,snapshotDir:context.snapshotDir,layout:'qualified'}).collect()})
        : resumeRun({runDir:process.argv[3],humanNodeRunId:process.argv[4],humanOutput:{approved:'true'},createResources,extensions});
      operation.then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1});
    `);
    const started = JSON.parse(execFileSync(process.execPath, [child, 'start'], { encoding: 'utf8', timeout: 5000 }));
    assert.equal(started.status, 'suspended');
    const snapshot = path.join(started.runDir, '.snapshot');
    for (const id of ['numbers.left', 'numbers.right$', 'other.left']) assert.ok(fs.existsSync(path.join(snapshot, id + '.itt.impl.json')));
    assert.equal(fs.existsSync(path.join(snapshot, 'left.itt.impl.json')), false);
    assert.ok(fs.existsSync(path.join(snapshot, 'other.left.source-map.json')));
    const human = await extractHumanNodeInfo(started.runDir, 'main', true);
    const resumed = JSON.parse(execFileSync(process.execPath, [child, 'resume', started.runDir, human.nodeRunId], { encoding: 'utf8', timeout: 5000 }));
    assert.equal(resumed.status, 'completed');
    assert.equal(fs.readFileSync(path.join(f.home, 'workspaces/result/total.txt'), 'utf8'), '60');
    const events = fs.readFileSync(path.join(started.runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event => event.event === 'frame_push' && event.callee === 'numbers.left').length, 1);
  } finally { await host?.close(); }
});

test('module preflight recompiles dependants, refuses stale symbols/layouts and keeps review bound to all sources', { timeout: 15000 }, async t => {
  const f = initialize(t), pool = new WorktreePool({ brainDir: f.brainDir, poolDir: path.join(f.root, 'pool'), size: 1 });
  const pipeline = createGenerationPipeline({ ...f, compileProgram });
  const worktree = pool.checkout('initial'); writeSources(worktree);
  const first = await pipeline.runPreflight(worktree, ['main/main']); assert.equal(first.ok, true, first.compileErrors);
  fs.appendFileSync(path.join(worktree, 'numbers.ts'), '\n// changed');
  await assert.rejects(pipeline.executeMerge(worktree, first, ['main/main']), /source changed/);
  const current = await pipeline.runPreflight(worktree, ['main/main']); assert.equal(current.ok, true, current.compileErrors);
  await pipeline.executeMerge(worktree, current, ['main/main']); pool.release(worktree, 'initial');
  const original = readArtifactTree(f.intentsDir), revision = git(f.brainDir, ['rev-parse', 'HEAD']);
  const second = pool.checkout('next');
  // Valid TypeScript, but two modules now recurse. Only numbers.ts changed.
  fs.writeFileSync(path.join(second, 'numbers.ts'), "import { main } from './main';\n" + files['numbers.ts'].replace('return { value: 10 };', 'await main(); return { value: 10 };'));
  const recursive = await pipeline.runPreflight(second, ['main/main']); assert.equal(recursive.ok, false); assert.match(recursive.compileErrors, /[Cc]ircular|[Rr]ecurs/);
  writeSources(second, { 'numbers.ts': files['numbers.ts'].replace('value: 10', 'value: 11') });
  const update = await pipeline.runPreflight(second, ['main/main']); assert.equal(update.ok, true, update.compileErrors);
  assert.deepEqual(update.modified, ['numbers.ts']);
  assert.ok(update.candidate.artifacts['main/main/main.itt.impl.json']);
  // Removing an unused export must not leave a callable stale installed artifact.
  fs.writeFileSync(path.join(second, 'main.ts'), files['main.ts'].replace('left as l, right$ as r', 'left as l').replace('const { value: b } = await r();', 'const b: number = 20;'));
  fs.writeFileSync(path.join(second, 'numbers.ts'), files['numbers.ts'].split('\n')[0]);
  const removed = await pipeline.runPreflight(second, ['main/main']); assert.equal(removed.ok, false); assert.match(removed.compileErrors, /separate migration/);
  assert.deepEqual(readArtifactTree(f.intentsDir), original); assert.equal(git(f.brainDir, ['rev-parse', 'HEAD']), revision);
  const invalid = await pipeline.runPreflight(second, ['main']); assert.equal(invalid.ok, false); assert.match(invalid.compileErrors, /Module entry/);
  assert.throws(() => createGenerationPipeline({ ...f, compileProgram, compileSource() {} }), /one source layout/);
});
