import { decodeSnapshot, decodeSource, decodeNodeIo, readRunArtifact } from '../../api/run-artifacts';
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });
const signal = () => new AbortController().signal;

test('run creation surfaces actionable input errors without JSON envelopes', async () => {
  const { startRun } = await import('../../api/runs');
  for (const body of [{ error: 'Choose an absolute workdir' }, { error: 'Internal Server Error', message: 'Workdir is not writable' }]) {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 400 }));
    await expect(startRun({ ittPath: 'demo', workdir: '../relative' })).rejects.toThrow(new Error(body.message ?? body.error));
  }
  global.fetch = jest.fn().mockResolvedValue(new Response('<html>unavailable</html>', { status: 503 }));
  await expect(startRun({ ittPath: 'demo', workdir: '/tmp/qa' })).rejects.toThrow(new Error('Could not start run (HTTP 503)'));
});

test('HTTP errors are not interpreted as workflow data or absent source', async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Bad Request', message: 'Invalid status filter: wrong' }), { status: 400 }));
  await expect(readRunArtifact('/api/runs?status=wrong', value => value, signal())).rejects.toThrow('Invalid status filter: wrong (HTTP 400)');
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Snapshot not found' }), { status: 404 }));
  await expect(readRunArtifact('/snapshot', decodeSnapshot, signal())).rejects.toThrow('Snapshot not found (HTTP 404)');
  global.fetch = jest.fn().mockResolvedValue(new Response('server failure', { status: 503 }));
  await expect(readRunArtifact('/source', decodeSource, signal())).rejects.toThrow('HTTP 503');
});

test('connection failures preserve the distinction between unreachable and missing data', async () => {
  global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(readRunArtifact('/source', decodeSource, signal())).rejects.toThrow('Cannot reach the server');
});

test('malformed successful responses are rejected before graph rendering', async () => {
  for (const value of [{ error: 'failure' }, { entry: 'END', nodes: null }, { entry: 'a', nodes: { a: null } },
    { entry: 'a', nodes: { a: { type: 'call', executor: 'ai' } } }]) {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(value)));
    await expect(readRunArtifact('/snapshot', decodeSnapshot, signal())).rejects.toThrow('invalid workflow snapshot');
  }
  global.fetch = jest.fn().mockResolvedValue(new Response('<html>unavailable</html>'));
  await expect(readRunArtifact('/snapshot', decodeSnapshot, signal())).rejects.toThrow('unreadable response');
});

test('valid empty source and falsy node values remain distinguishable from failed reads', () => {
  expect(decodeSource({ ts: '' })).toBe('');
  expect(decodeNodeIo({ inputs: { text: '', count: 0, enabled: false }, outputs: null })).toEqual({ inputs: { text: '', count: 0, enabled: false }, outputs: null });
  expect(() => decodeNodeIo({ error: 'missing' })).toThrow('invalid node details');
  expect(decodeSnapshot({ entry: 'END', nodes: {} })).toEqual({ entry: 'END', nodes: {} });
});

test('a request deadline aborts the fetch and exposes a retryable timeout', async () => {
  const deadline = new AbortController();
  jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  global.fetch = jest.fn((_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason));
  })) as typeof fetch;
  const pending = readRunArtifact('/source', decodeSource, signal());
  deadline.abort(new DOMException('Timeout', 'TimeoutError'));
  await expect(pending).rejects.toThrow('within 15 seconds');
  expect(AbortSignal.timeout).toHaveBeenCalledWith(15000);
});

test('navigation cancellation reaches the request without being mislabeled a server failure', async () => {
  const navigation = new AbortController();
  global.fetch = jest.fn((_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason));
  })) as typeof fetch;
  const pending = readRunArtifact('/snapshot', decodeSnapshot, navigation.signal);
  navigation.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

test('run reads retain HTTP status so definite missing IDs can stop automatic polling', async () => {
  const { getRun, RunReadError } = await import('../../api/runs');
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Run not found' }), { status: 404 }));
  try { await getRun('missing'); throw new Error('expected rejection'); }
  catch (error) { expect(error).toBeInstanceOf(RunReadError); expect(error).toMatchObject({ status: 404, message: 'Run not found' }); }
});

test('run detail reads preserve the root frame and earlier iterations beyond the server event tail', async () => {
  const { getRun } = await import('../../api/runs');
  const events = [
    { event: 'node_pending', frame_id: 'root', node_id: 'for_1' },
    ...Array.from({ length: 220 }, (_, i) => ({ event: 'node_pending', frame_id: 'child', node_id: `child_${i}` })),
    { event: 'run_complete', status: 'completed' },
  ];
  // Match the server's default 200-event window and its explicit zero = all contract.
  global.fetch = jest.fn(async (url) => {
    const query = new URL(String(url), 'http://localhost').searchParams;
    const tail = query.has('tailEvents') ? Number(query.get('tailEvents')) : 200;
    return new Response(JSON.stringify({ events: events.slice(-tail) }));
  }) as typeof fetch;
  expect((await getRun('long-nested')).events).toEqual(events);
  expect((await getRun('long-nested', 0)).events).toEqual(events);
  expect((await getRun('long-nested', 2)).events).toEqual(events.slice(-2));
});

test('history list reads have a deadline rather than waiting indefinitely', async () => {
  const { listRuns } = await import('../../api/runs');
  const deadline = new AbortController();
  jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  global.fetch = jest.fn((_url, options) => new Promise((_resolve, reject) => {
    if (!options?.signal) { reject(new Error('List request has no deadline')); return; }
    options.signal.addEventListener('abort', () => reject(options.signal!.reason));
  })) as typeof fetch;
  const pending = listRuns({ page: 1 });
  deadline.abort(new DOMException('Timed out', 'TimeoutError'));
  await expect(pending).rejects.toThrow('did not respond within 15 seconds');
  expect(AbortSignal.timeout).toHaveBeenCalledWith(15000);
});
