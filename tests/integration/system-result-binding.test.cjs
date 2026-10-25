const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileProgram, compileMultiIntent } = require('@openhilo/compiler');
const { startRun } = require('@openhilo/runtime/run-service');
const { EntityStore, createSysExecutor, platformSystemMethods } = require('@openhilo/platform-services');

const source = `export async function main(content: string): Promise<{id: string; created: boolean; content: string; count: number; name: string}> {
  const saved = await createEntity_by_sys('Note', 'same', {content: content}, 'Saved note', {});
  if (saved.created === false) {
    const prior = await getEntityField_by_sys(saved.id, '$.content');
    const updated = await updateEntityField_by_sys(saved.id, '$.content', content, prior.entityVersion);
  }
  const stored = await getEntityField_by_sys(saved.id, '$.content');
  const records = await queryEntities_by_sys('Note');
  const record = await getEntity_by_sys(saved.id);
  return {id: saved.id, created: saved.created, content: stored.value, count: records.result.length, name: record.result.name};
}`;

for (const mode of ['legacy', 'program']) test(`${mode}: system result objects preserve all fields through persisted create, update and read`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'system-result-'));
  let store = new EntityStore(path.join(root, 'entities.db'));
  t.after(() => { store.close(); fs.rmSync(root, {recursive: true, force: true}); });
  store.defineClass('Note', {content: 'text'}, 'Notes', {});
  let workflow;
  if (mode === 'legacy') workflow = compileMultiIntent(source, '', [], {systemMethods: platformSystemMethods}).intents[0].implementation;
  else {
    const compiled = compileProgram({files: {'main.ts': source}, entries: [{file: 'main.ts', exportName: 'main'}], systemMethods: platformSystemMethods});
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    workflow = compiled.artifacts[0].implementation;
  }
  const entryFile = path.join(root, 'main.itt.impl.json'); fs.writeFileSync(entryFile, JSON.stringify(workflow));
  let id;
  for (const content of ['first', 'updated']) {
    const execute = createSysExecutor({mode: 'direct', entityManager: store});
    const result = await startRun({intent: 'main', entryFile, workdir: path.join(root, content), runsDir: path.join(root, 'runs'), inputs: {content},
      populateSnapshot({snapshotDir}) {fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)));},
      createResources: () => ({executor: (node, inputs) => execute(node, inputs, {caller: 'executor_sys'})})});
    assert.equal(result.status, 'completed');
    const events = fs.readFileSync(path.join(result.runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const outputs = events.at(-1).outputs;
    id ??= outputs.id;
    assert.deepEqual(outputs, {id, created: content === 'first', content, count: 1, name: 'same'});
    store.close(); store = new EntityStore(path.join(root, 'entities.db'));
    assert.equal(store.getEntity(id).data.content, content);
  }
  assert.equal(store.getEntity(id).version, 2);
});
