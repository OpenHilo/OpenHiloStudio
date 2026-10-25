const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EntityStore, createPlatformToolHost, createSysExecutor } = require('@openhilo/platform-services');

async function runExample() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-platform-example-'));
  const database = path.join(directory, 'entities.db');
  let store = new EntityStore(database);
  try {
    if (store.getTagDefinitions().length) throw new Error('Unexpected application seed');
    const tools = createPlatformToolHost(store, { allowDefineClass: true });
    const defined = await tools.invoke({ callId: 'define', name: 'define_class', arguments: {
      className: 'Document', schema: { title: 'text' }, desc: 'A general document', tags: {},
    } }, new AbortController().signal);
    if (!defined.ok || !defined.output.ok) throw new Error('Class definition failed');
    const execute = createSysExecutor({ mode: 'direct', entityManager: store });
    const { outputs } = await execute({ id: 'create', type: 'call', executor: 'sys', callee: 'createEntity', inputsFrom: {},
      outputsTo: { id: 'id', created: 'created' }, outputs: { id: 'text', created: 'boolean' }, next: 'END' }, {
      className: 'Document', name: 'note', initData: { title: 'Original' }, desc: 'Example', tags: {},
    }, { caller: 'executor_sys' });
    store.updateEntityField(outputs.id, '$.title', 'Updated', 1);
    store.close(); store = new EntityStore(database);
    const loaded = await createPlatformToolHost(store).invoke({ callId: 'read', name: 'getEntity', arguments: { entityId: outputs.id } }, new AbortController().signal);
    if (!loaded.ok) throw new Error('Entity read failed');
    return { entity: loaded.output, definitions: store.getTagDefinitions() };
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { runExample };
if (require.main === module) runExample().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
