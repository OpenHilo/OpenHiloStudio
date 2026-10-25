import { getHumanNode, getHumanHistory, submitHumanTask, HumanRequestError } from '../../api/human';
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

test('human reads have a deadline and retain HTTP status for stale or stopped forms', async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Run is stopping' }), { status: 409 }));
  await expect(getHumanNode('run')).rejects.toEqual(new HumanRequestError('Run is stopping', 409));
  expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
test('unconfirmed writes preserve uncertainty and never retry an answer automatically', async () => {
  global.fetch = jest.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
  await expect(submitHumanTask('run', { taskId: 't', submissionId: 's', outputs: {} })).rejects.toThrow('may already have been saved');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('response-body interruption is also reported as an unconfirmed write', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => { throw Error('body disconnected'); } });
  await expect(submitHumanTask('run', { taskId: 't', submissionId: 's', outputs: {} })).rejects.toThrow('may already have been saved');
});
test('history combines caller cancellation and a bounded deadline', async () => {
  const controller = new AbortController();
  global.fetch = jest.fn(async (_url, init) => {
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
    throw new DOMException('cancelled', 'AbortError');
  });
  await expect(getHumanHistory('run', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
test('non-JSON HTTP errors keep their status and successful wire values false/zero/empty stay intact', async () => {
  global.fetch = jest.fn().mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ acceptedSubmission: { outputs: { a: 'false', b: '0', c: '' } } })));
  await expect(getHumanNode('run')).rejects.toThrow('HTTP 503');
  expect((await getHumanNode('run')).acceptedSubmission?.outputs).toEqual({ a: 'false', b: '0', c: '' });
});
