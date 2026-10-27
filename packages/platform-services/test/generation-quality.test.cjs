const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGenericPrompt } = require('@openhilo/generation-contracts');
const { createGenerationPipeline } = require('@openhilo/platform-services/generation-pipeline');
const { compileProgram } = require('@openhilo/compiler');

test('prompt describes the actual publication compiler and its completion identity', () => {
  const options = { brainDir: '/tmp/quality-brain', intentsDir: '/tmp/quality-intents' };
  for (const [configuration, layout] of [[{}, 'legacy-files'], [{ compileProgram }, 'modules']]) {
    const pipeline = createGenerationPipeline({ ...options, ...configuration });
    assert.equal(pipeline.sourceLayout, layout);
    const prompt = buildGenericPrompt({ naturalLanguage: 'Research', round: 1, maxRounds: 1, sourceLayout: pipeline.sourceLayout });
    if (layout === 'modules') {
      assert.match(prompt.systemPrompt, /type aliases/);
      assert.match(prompt.systemPrompt, /namespace\/file\/exportName/);
    } else {
      assert.match(prompt.systemPrompt, /Do not create shared type modules/);
      assert.doesNotMatch(prompt.systemPrompt, /namespace\/file\/exportName/);
    }
  }
});

test('research quality contract distinguishes evidence failure from a completed business outcome', () => {
  const { systemPrompt } = buildGenericPrompt({ naturalLanguage: 'Find useful current resources', round: 1, maxRounds: 1 });
  assert.match(systemPrompt, /insufficient_evidence/);
  assert.match(systemPrompt, /runtime tools/);
  assert.match(systemPrompt, /enum values/);
  assert.match(systemPrompt, /truncat/i);
  assert.match(systemPrompt, /no relevant results/i);
  assert.doesNotMatch(systemPrompt, /all physical actions|AI.*must never.*tools/i);
});


test('generation represents incomplete research without inventing values or hidden acceptance gates', () => {
  const { systemPrompt } = buildGenericPrompt({ naturalLanguage: 'Find suitable resources', round: 1, maxRounds: 1 });
  assert.match(systemPrompt, /unknown, rejected and partial outcomes/);
  assert.match(systemPrompt, /optional or nullable/);
  assert.match(systemPrompt, /explicit, reviewable assumptions/);
  assert.match(systemPrompt, /ancillary unknowns/);
  assert.match(systemPrompt, /consumer and runtime shape validator/);
});


test('module research contracts accept declared unknown fields while rejecting fabricated types', () => {
  const { validateInputShape } = require('@openhilo/itt-contracts/run-inputs');
  const result = compileProgram({
    files: {
      'types.ts': "export type Candidate = { status: 'verified' | 'unknown'; apiBase?: string; price: number | null };",
      'research.ts': "import type { Candidate } from './types'; declare function inspect_by_ai(role:string,prompt:string):Promise<{candidates:Candidate[]}>; export async function inspect():Promise<{candidates:Candidate[]}>{return await inspect_by_ai('researcher','Inspect actual sources');}"
    }, entries: [{ file: 'research.ts', exportName: 'inspect' }]
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const shape = Object.values(result.artifacts[0].implementation.nodes).find(n => n.executor === 'ai').outputShapes.candidates;
  assert.doesNotThrow(() => validateInputShape([{ status: 'unknown', price: null }], shape, 'candidates'));
  assert.throws(() => validateInputShape([{ status: 'unknown' }], shape, 'candidates'), /price: required/);
  assert.throws(() => validateInputShape([{ status: 'verified', apiBase: 42, price: 0.2 }], shape, 'candidates'), /apiBase/);
  assert.throws(() => validateInputShape([{ status: 'invented', price: null }], shape, 'candidates'), /status/);
});
