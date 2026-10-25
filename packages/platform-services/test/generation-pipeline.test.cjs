const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { createTaskExecution } = require('@openhilo/ai-contracts');
const { GenerationSession } = require('@openhilo/platform-services/generation-session');
const { createGenerationPipeline } = require('@openhilo/platform-services/generation-pipeline');
const { WorktreePool } = require('@openhilo/platform-services/worktree-pool');
const { git } = require('@openhilo/platform-services/publication');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-pipeline-'));
  const brainDir = path.join(root, 'brain'), intentsDir = path.join(root, 'intents');
  fs.mkdirSync(brainDir); fs.mkdirSync(intentsDir);
  git(brainDir, ['init', '-b', 'main']);
  git(brainDir, ['config', 'user.email', 'fixture@local']); git(brainDir, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(brainDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['**/*.ts'] }));
  fs.writeFileSync(path.join(brainDir, 'keep.ts'), 'export const keep = 1;');
  git(brainDir, ['add', '.']); git(brainDir, ['commit', '-m', 'fixture']);
  const pool = new WorktreePool({ brainDir, poolDir: path.join(root, 'pool'), size: 1 });
  const pipeline = createGenerationPipeline({ brainDir, intentsDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, brainDir, intentsDir, pool, pipeline };
}
const source = '/** @entry */\nexport async function report(): Promise<{ value: number }> { return { value: 42 }; }';

for (const layout of ['legacy', 'module']) for (const names of [['Flow', 'flow'], ['caf\u00e9', 'cafe\u0301']]) {
  test(`${layout} preflight never silently aliases workflow names ${JSON.stringify(names)}`, async t => {
    const f = setup(t);
    git(f.brainDir, ['rm', 'keep.ts']); git(f.brainDir, ['commit', '-m', 'Only workflow modules']);
    const worktree = f.pool.checkout('name-collision');
    const text = names.map((name, i) => `export async function ${name}(): Promise<{ value: number }> { return { value: ${i + 1} }; }`).join('\n');
    fs.mkdirSync(path.join(worktree, 'demo')); fs.writeFileSync(path.join(worktree, 'demo/flows.ts'), text);
    fs.writeFileSync(path.join(f.root, names[0]), 'probe');
    const aliases = fs.existsSync(path.join(f.root, names[1]));
    const pipeline = layout === 'module' ? createGenerationPipeline({ brainDir: f.brainDir, intentsDir: f.intentsDir,
      compileProgram: require('@openhilo/compiler').compileProgram }) : f.pipeline;
    const before = git(f.brainDir, ['rev-parse', 'HEAD']);
    const result = await pipeline.runPreflight(worktree, [layout === 'module' ? `demo/flows/${names[0]}` : `demo/${names[0]}`]);
    if (aliases) {
      assert.equal(result.ok, false, 'Aliased workflow artifacts must not become a publishable receipt');
      assert.match(result.compileErrors, /collid|collision|distinct/i);
      assert.equal(result.candidate, undefined);
    } else {
      assert.equal(result.ok, true, result.compileErrors);
      assert.equal(Object.keys(result.candidate.artifacts).filter(file => file.endsWith('.itt.impl.json')).length, 2);
    }
    assert.equal(git(f.brainDir, ['rev-parse', 'HEAD']), before);
    assert.deepEqual(fs.readdirSync(f.intentsDir), []);
    assert.equal(fs.readFileSync(path.join(worktree, 'demo/flows.ts'), 'utf8'), text);
  });
}

test('an advanced target cannot create an unpublishable review loop; synchronization retains the candidate', async t => {
  const f = setup(t), worktree = f.pool.checkout('target-drift');
  writeCandidate(worktree);
  const first = await f.pipeline.runPreflight(worktree, ['demo/report']);
  assert.equal(first.ok, true, first.compileErrors);
  fs.writeFileSync(path.join(f.brainDir, 'keep.ts'), 'export const keep = 2;');
  git(f.brainDir, ['add', 'keep.ts']); git(f.brainDir, ['commit', '-m', 'advance target']);
  await assert.rejects(f.pipeline.executeMerge(worktree, first, ['demo/report']), /base changed/);
  for (let i = 0; i < 2; i++) {
    const stale = await f.pipeline.runPreflight(worktree, ['demo/report']);
    assert.equal(stale.ok, false);
    assert.equal(stale.requiresTargetSync, true);
    assert.equal(stale.candidate, undefined);
    assert.match(stale.compileErrors, /Synchronize.*candidate.*retained/);
  }
  assert.equal(fs.readFileSync(path.join(worktree, 'demo/report.ts'), 'utf8'), source);
  assert.deepEqual(fs.readdirSync(f.intentsDir), []);
  git(worktree, ['merge', '--ff-only', 'main']);
  const fresh = await f.pipeline.runPreflight(worktree, ['demo/report']);
  assert.equal(fresh.ok, true, fresh.compileErrors);
  await f.pipeline.executeMerge(worktree, fresh, ['demo/report']);
  assert.equal(fs.readFileSync(path.join(f.brainDir, 'keep.ts'), 'utf8'), 'export const keep = 2;');
  assert.equal(fs.readFileSync(path.join(f.brainDir, 'demo/report.ts'), 'utf8'), source);
});
function writeCandidate(worktree, text = source) {
  fs.mkdirSync(path.join(worktree, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'demo', 'report.ts'), text);
}

test('standalone generation composes real leases, compiler preflight and approved publication', async t => {
  const f = setup(t);
  let started = 0;
  const aiExecutor = { id: 'offline', capabilities: ['workspace', 'questions', 'structured_output'],
    async start(request, host) { started++; return createTaskExecution(request, host, async () => {
      writeCandidate(fileURLToPath(host.workspace.uri));
      return { status: 'completed', outputs: { entries: ['demo/report'] }, artifacts: [] };
    }); } };
  const session = GenerationSession.create({ workspace: f.brainDir, sessionDir: path.join(f.root, 'session'), publicationDir: f.intentsDir,
    maxClarificationRounds: 2, maxFeedbackRounds: 3, aiExecutor,
    services: { ...f.pipeline, checkoutWorktree: id => f.pool.checkout(id), assertWorktreeOwner: (dir, id) => f.pool.assertOwner(dir, id), returnWorktree: (dir, id) => f.pool.release(dir, id) } });
  t.after(() => session.flushPersistence());
  const review = await session.respond({ type: 'start', naturalLanguage: 'Create report' });
  assert.equal(review.phase, 'confirm_merge', JSON.stringify(review));
  assert.equal(review.preflight.ok, true);
  assert.deepEqual(fs.readdirSync(f.intentsDir), []);
  assert.equal(fs.existsSync(path.join(f.brainDir, 'demo')), false);
  assert.equal((await session.respond({ type: 'merge_approve', reviewId: session.currentStep().reviewId })).phase, 'done');
  assert.equal(started, 1);
  assert.equal(fs.readFileSync(path.join(f.brainDir, 'demo', 'report.ts'), 'utf8'), source);
  const artifact = JSON.parse(fs.readFileSync(path.join(f.intentsDir, 'demo', 'report', 'report.itt.impl.json'), 'utf8'));
  assert.ok(artifact.nodes); assert.equal(artifact.level, undefined);
  assert.equal(f.pool.snapshot()['ws-01'].status, 'vacant');
  assert.equal(fs.existsSync(path.join(session.toJSON().archivedWorktreePath, 'demo', 'report.ts')), true);
});

test('file-layout publication binds every exported workflow to the exact approved source file', async t => {
  const f = setup(t), worktree = f.pool.checkout('source-metadata');
  const approved = '\n// Keep the reviewed file comments and whitespace.\n\n' + source +
    '\n\nexport async function helper(): Promise<{ value: number }> { return { value: 7 }; }\n\n';
  writeCandidate(worktree, approved);
  const result = await f.pipeline.runPreflight(worktree, ['demo/report', 'demo/helper']);
  assert.equal(result.ok, true, result.compileErrors);
  await f.pipeline.executeMerge(worktree, result, ['demo/report', 'demo/helper']);
  assert.equal(fs.readFileSync(path.join(f.brainDir, 'demo', 'report.ts'), 'utf8'), approved);
  assert.equal(fs.existsSync(path.join(f.brainDir, 'demo', 'helper.ts')), false);
  const expectedHash = 'sha256:' + createHash('sha256').update(approved).digest('hex');
  for (const name of ['report', 'helper']) {
    for (const suffix of ['itt.json', 'itt.impl.json']) {
      const artifact = JSON.parse(fs.readFileSync(path.join(f.intentsDir, 'demo', name, `${name}.${suffix}`), 'utf8'));
      assert.equal(artifact.sourceTs, expectedHash, `${name}.${suffix} source hash`);
      assert.equal(artifact.sourceFile, 'demo/report.ts', `${name}.${suffix} source path`);
    }
  }
});

test('real type and DSL failures cannot mutate published files', async t => {
  const f = setup(t), worktree = f.pool.checkout('invalid');
  for (const text of [source.replace('value: 42', 'value: "wrong"'), 'export async function report(): Promise<{}> { throw new Error("unsupported"); }']) {
    writeCandidate(worktree, text);
    const result = await f.pipeline.runPreflight(worktree, ['demo/report']);
    assert.equal(result.ok, false); assert.ok(result.compileErrors); assert.equal(result.candidate, undefined);
    assert.deepEqual(fs.readdirSync(f.intentsDir), []);
    assert.equal(git(f.brainDir, ['status', '--porcelain']).trim(), '');
  }
});

test('receipts are bound to configured destinations and reviewed source content', async t => {
  const f = setup(t), worktree = f.pool.checkout('receipt'); writeCandidate(worktree);
  const legacy = await f.pipeline.runPreflight(worktree, ['demo/report'], { legacyEntryTags: true });
  assert.equal(legacy.ok, false); assert.match(legacy.compileErrors, /requires an application compiler/);
  const result = await f.pipeline.runPreflight(worktree, ['demo/report']); assert.equal(result.ok, true, result.compileErrors);
  const other = createGenerationPipeline({ brainDir: f.brainDir, intentsDir: path.join(f.root, 'another') });
  await assert.rejects(other.executeMerge(worktree, result, ['demo/report']), /different configured target/);
  fs.appendFileSync(path.join(worktree, 'demo', 'report.ts'), '\n// changed after review');
  await assert.rejects(f.pipeline.executeMerge(worktree, result, ['demo/report']), /source changed/);
  assert.deepEqual(fs.readdirSync(f.intentsDir), []);
  assert.throws(() => createGenerationPipeline({ brainDir: '.', intentsDir: f.intentsDir }), /explicit absolute paths/);
});

test('restored receipts require current compiler validation and a fresh review before publication', async t => {
  const f = setup(t), worktree = f.pool.checkout('compiler-restart');
  writeCandidate(worktree);
  const prior = await f.pipeline.runPreflight(worktree, ['demo/report']);
  assert.equal(prior.ok, true, prior.compileErrors);
  const saved = JSON.parse(JSON.stringify(prior));
  const restarted = createGenerationPipeline({ brainDir: f.brainDir, intentsDir: f.intentsDir });
  await assert.rejects(restarted.executeMerge(worktree, saved, ['demo/report']), /review again/);
  assert.deepEqual(fs.readdirSync(f.intentsDir), []);
  assert.equal(fs.existsSync(path.join(f.brainDir, 'demo/report.ts')), false);
  const current = await restarted.runPreflight(worktree, ['demo/report']);
  assert.equal(current.ok, true, current.compileErrors);
  assert.notEqual(current.candidate.reviewId, saved.candidate.reviewId);
  await restarted.executeMerge(worktree, current, ['demo/report']);
  assert.equal(fs.readFileSync(path.join(f.brainDir, 'demo/report.ts'), 'utf8'), source);
});

test('an upgraded compiler rejection preserves the restored candidate without publishing old artifacts', async t => {
  const f = setup(t), id = 'compiler-rejection', worktree = f.pool.checkout(id);
  writeCandidate(worktree);
  const prior = await f.pipeline.runPreflight(worktree, ['demo/report']);
  assert.equal(prior.ok, true, prior.compileErrors);
  const sessionDir = path.join(f.root, 'sessions', id);
  const session = GenerationSession.fromJSON(JSON.parse(JSON.stringify({ id,
    config: { workspace: f.brainDir, publicationDir: f.intentsDir, sessionDir, maxClarificationRounds: 2, maxFeedbackRounds: 3 },
    sessionDir, phase: 'confirm_merge', round: 1, feedbackRoundsUsed: 0, naturalLanguage: 'Create report',
    worktreePath: worktree, pendingPreflight: prior, pendingEntries: ['demo/report'], answers: {}, answerHistory: [] })));
  const upgraded = createGenerationPipeline({ brainDir: f.brainDir, intentsDir: f.intentsDir,
    compileSource() { throw new Error('This source is rejected by the upgraded compiler'); } });
  session.bindServices({ ...upgraded, checkoutWorktree: s => f.pool.checkout(s),
    assertWorktreeOwner: (dir, s) => f.pool.assertOwner(dir, s), returnWorktree: (dir, s) => f.pool.release(dir, s) });
  t.after(() => session.flushPersistence());
  await assert.rejects(session.respond({ type: 'merge_approve', reviewId: session.currentStep().reviewId }), /rejected by the upgraded compiler/);
  assert.equal(session.currentStep().phase, 'confirm_merge');
  assert.deepEqual(fs.readdirSync(f.intentsDir), []);
  assert.equal(fs.existsSync(path.join(f.brainDir, 'demo/report.ts')), false);
  assert.equal(fs.readFileSync(path.join(worktree, 'demo/report.ts'), 'utf8'), source);
  assert.equal(f.pool.snapshot()['ws-01'].sessionId, id);
  assert.equal(f.pool.snapshot()['ws-01'].status, 'active');
});
