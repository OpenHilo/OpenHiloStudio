import { listNamespaces, getNamespaceDetail, getIntentItt } from '../../api/namespaces';
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
test('library failures preserve HTTP errors instead of becoming empty namespaces', async () => {
  global.fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Fixture unavailable' }), { status: 503 }))
    .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));
  await expect(listNamespaces()).rejects.toThrow('Fixture unavailable');
  await expect(getNamespaceDetail('demo')).rejects.toThrow('HTTP 502');
});
test('library reads reject malformed shapes and bound their lifetime', async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ wrong: [] })));
  await expect(listNamespaces()).rejects.toThrow('invalid library data');
  expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ leaf: {}, impl: { nodes: [] }, ts: null })));
  await expect(getIntentItt('demo', 'task')).rejects.toThrow('invalid library data');
});
test('optional implementation and empty source remain valid while cancelled navigation aborts its request', async () => {
  const controller = new AbortController();
  global.fetch = jest.fn(async (_url, options) => {
    controller.abort(); expect(options?.signal?.aborted).toBe(true);
    return new Response(JSON.stringify({ leaf: {}, impl: null, ts: '' }));
  });
  expect(await getIntentItt('demo', 'task', controller.signal)).toEqual({ leaf: {}, impl: null, ts: '' });
});
