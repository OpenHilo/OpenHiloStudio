import { webcrypto } from 'node:crypto';
import { respondTranslate, pollTranslate } from '../../api/translate';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('generation conflicts show the server explanation without the HTTP JSON wrapper', async () => {
  globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({ statusCode: 409, error: 'Conflict', message: 'Your answer was not applied. Refresh the task.' }), { status: 409 })) as typeof fetch;
  await expect(respondTranslate('sid', { type: 'mcp_answer', questionId: 'old', answer: 'keep draft' }))
    .rejects.toThrow('Your answer was not applied. Refresh the task.');
});

test('non-JSON generation errors retain HTTP status instead of displaying a raw server page', async () => {
  globalThis.fetch = jest.fn(async () => new Response('<html>proxy error</html>', { status: 502 })) as typeof fetch;
  await expect(pollTranslate('sid')).rejects.toThrow('The server could not load this data (HTTP 502)');
});

test('lost creation receipts reuse the saved identity after a page reload and clear it only after acknowledgement', async () => {
  const values = new Map<string, string>();
  const oldCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } });
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } });
  const bodies: Array<{ requestId?: string; naturalLanguage: string }> = [];
  try {
    globalThis.fetch = jest.fn(async (_url, options) => {
      bodies.push(JSON.parse(options!.body as string));
      throw new TypeError('connection lost');
    }) as typeof fetch;
    const first = await import('../../api/translate');
    await expect(first.startTranslate('Preserve my exact request')).rejects.toThrow(/not confirmed|could not be confirmed/i);
    expect(bodies[0].requestId).toMatch(/^[a-f0-9-]{36}$/i);
    jest.resetModules();
    const reloaded = await import('../../api/translate');
    globalThis.fetch = jest.fn(async (_url, options) => {
      const body = JSON.parse(options!.body as string); bodies.push(body);
      return new Response(JSON.stringify({ sessionId: body.requestId, step: { phase: 'confirm_merge' } }));
    }) as typeof fetch;
    const recovered = await reloaded.startTranslate('Preserve my exact request');
    expect(recovered.sessionId).toBe(bodies[0].requestId);
    expect(bodies[1]).toEqual(bodies[0]);
    // The UI may have unmounted before the response; transport success alone
    // must not forget an identity that the user has never received.
    await reloaded.startTranslate('Preserve my exact request');
    expect(bodies[2].requestId).toBe(bodies[0].requestId);
    reloaded.acknowledgeTranslateStart(recovered.sessionId);
    await reloaded.startTranslate('Preserve my exact request');
    expect(bodies[3].requestId).not.toBe(bodies[0].requestId);
  } finally {
    if (oldCrypto) Object.defineProperty(globalThis, 'crypto', oldCrypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
    if (oldStorage) Object.defineProperty(globalThis, 'sessionStorage', oldStorage);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});
