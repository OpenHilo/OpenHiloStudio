const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileMultiIntent } = require('@openhilo/compiler');
const { startRun } = require('@openhilo/runtime/run-service');
const { Snapshotter } = require('../dist/brain-snapshot');

for (const qualifiedCall of [true, false]) test(`legacy snapshots execute ${qualifiedCall ? 'qualified' : 'unqualified'} child calls`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qualified-legacy-snapshot-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const compiled = compileMultiIntent('export async function child(value:number):Promise<{value:number}>{return {value:value*2};}\nexport async function main():Promise<{value:number}>{const childResult=await child(19);return {value:childResult.value};}', 'team');
  for (const artifact of compiled.intents) {
    if (!qualifiedCall) {
      artifact.implementation.imports = { child: 'team.child' };
      for (const node of Object.values(artifact.implementation.nodes)) if (node.callee === 'team.child') node.callee = 'child';
    }
    const dir = path.join(home, 'intents', 'team', artifact.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${artifact.name}.itt.impl.json`), JSON.stringify(artifact.implementation));
  }
  const entryFile = path.join(home, 'intents/team/main/main.itt.impl.json');
  const events = [];
  const result = await startRun({ intent: 'main', entryFile, workdir: path.join(home, 'workspace'), runsDir: path.join(home, 'runs'), inputs: {},
    populateSnapshot: ({ snapshotDir }) => new Snapshotter({ ittHome: home, entryFile, snapshotDir }).collect(),
    createResources: () => ({ executor: async () => { throw new Error('Child call must run inside runtime'); } }),
    onEvent: event => events.push(event),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events.find(event => event.event === 'run_complete').outputs, { value: 38 });
});
