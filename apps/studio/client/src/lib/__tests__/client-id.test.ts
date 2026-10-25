import { webcrypto } from 'node:crypto';
import { createClientId } from '../client-id';
import { submitInboxItem, type InboxDraft } from '../human-inbox';
import type { HumanNodeDetail } from '../../api/human';
import { answerAiQuestion } from '../../api/ai-questions';

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalFetch = globalThis.fetch;
function useCrypto(value: unknown) { Object.defineProperty(globalThis, 'crypto', { configurable: true, value }); }
function httpCrypto() { useCrypto({ getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }); }
afterEach(() => {
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else Reflect.deleteProperty(globalThis, 'crypto');
  globalThis.fetch = originalFetch;
});

test('uses the browser UUID implementation with its receiver when available', () => {
  const source = { randomUUID() { expect(this).toBe(source); return 'native-uuid'; } };
  useCrypto(source);
  expect(createClientId()).toBe('native-uuid');
});

test('LAN HTTP fallback produces independent version 4 UUIDs with a secure random source', () => {
  httpCrypto();
  const ids = Array.from({ length: 1000 }, () => createClientId());
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(new Set(ids).size).toBe(ids.length);
});

test('fallback preserves random bytes except version and variant bits', () => {
  const source = { getRandomValues(bytes: Uint8Array) { expect(this).toBe(source); bytes.fill(255); return bytes; } };
  useCrypto(source);
  expect(createClientId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
});

test('missing crypto reports an actionable error instead of using a weak request identity', () => {
  useCrypto(undefined);
  expect(createClientId).toThrow('This browser cannot create a request ID');
});

test('Human answer on HTTP keeps the same persisted receipt after a lost response', async () => {
  httpCrypto();
  const node: HumanNodeDetail = { runId: 'http-test', intent: 'test', workdir: '/tmp', nodeId: 'human', taskId: 'task', prompt: 'Approve', resolvedInputs: {}, suspendedAt: '', outputs: [{ name: 'ok', kind: 'boolean' }] };
  const sent: unknown[] = [];
  let saved: InboxDraft | undefined;
  globalThis.fetch = jest.fn(async (_url, init) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify(node));
    sent.push(JSON.parse(init.body as string));
    if (sent.length === 1) throw new TypeError('lost response');
    return new Response(JSON.stringify({ status: 'duplicate' }));
  }) as typeof fetch;
  expect((await submitInboxItem(node, { values: { ok: 'true' } }, undefined, draft => { saved = draft; })).state).toBe('unknown');
  expect(saved?.submission?.submissionId).toMatch(/^[0-9a-f-]{36}$/);
  expect((await submitInboxItem(node, saved!)).state).toBe('accepted');
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
});

test('AI question answers remain usable without randomUUID and keep their existing identity', async () => {
  httpCrypto();
  const key = { taskId: 't', attemptId: 'a', questionId: 'q' };
  globalThis.fetch = jest.fn(async (_url, init) => {
    expect(JSON.parse(init!.body as string)).toEqual({ key, value: 'verified' });
    return new Response(JSON.stringify({ receipt: 'accepted' }));
  }) as typeof fetch;
  await expect(answerAiQuestion('http-test', key, 'verified')).resolves.toBe('accepted');
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});
