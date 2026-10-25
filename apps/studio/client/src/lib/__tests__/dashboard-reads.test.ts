import { getStats } from '../../api/stats';
import { getConfig } from '../../api/config';
import { getHumanTodos } from '../../api/human';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

test.each([getStats, getConfig, getHumanTodos])('dashboard/settings reads honour cancellation and have a deadline', async read => {
  const controller = new AbortController();
  global.fetch = jest.fn(async (_url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal).not.toBe(controller.signal);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
    throw new DOMException('cancelled', 'AbortError');
  });
  await expect(read(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test.each([getStats, getConfig])('a timed-out read gives a recovery action, not empty data', async read => {
  global.fetch = jest.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
  await expect(read()).rejects.toThrow('Check the server connection and retry');
});

test('failed or malformed statistics cannot appear as valid zero counts', async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(new Response(JSON.stringify({totalRuns:0,runningRuns:0,completedToday:0,failedRuns:0,pendingHumanNodes:0})));
  await expect(getStats()).rejects.toThrow('HTTP 503');
  await expect(getStats()).rejects.toThrow('Invalid dashboard statistics');
  expect((await getStats()).totalRuns).toBe(0);
});

test('malformed human task response is not treated as an empty queue', async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response('{}'));
  await expect(getHumanTodos()).rejects.toThrow('Invalid pending human tasks');
});
