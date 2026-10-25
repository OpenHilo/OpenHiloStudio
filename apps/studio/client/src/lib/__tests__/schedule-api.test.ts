import { createSchedule, deleteSchedule, getScheduleMeta, listSchedules } from '../../api/schedules';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

test.each(['UTC', null])('schedule metadata preserves the actual timezone %s', async timeZone => {
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ timeZone })));
  await expect(getScheduleMeta()).resolves.toEqual({ timeZone });
});

test('invalid schedule metadata is reported instead of inventing a timezone', async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ timeZone: 5 })));
  await expect(getScheduleMeta()).rejects.toThrow('scheduler time zone');
});

test('schedule validation errors expose the server explanation instead of raw JSON', async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Invalid cron expression' }), { status: 400 }));
  await expect(createSchedule({ name: 'test', cron: 'bad', ittPath: '/test', workdir: '/tmp', inputs: {}, enabled: true })).rejects.toThrow('Invalid cron expression');
});

test('lost write acknowledgements do not claim that nothing was saved', async () => {
  global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(deleteSchedule('test')).rejects.toThrow('it may already have been saved');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('read failure offers a refresh path and does not return an empty list', async () => {
  global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(listSchedules()).rejects.toThrow('try Refresh');
});

test('delete accepts the empty successful response without parsing JSON', async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 204 }));
  await expect(deleteSchedule('test')).resolves.toBeUndefined();
});
