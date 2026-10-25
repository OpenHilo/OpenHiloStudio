import { createEntity, deleteEntity, listClasses, updateEntity } from '../../api/entities';
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

test('entity requests use a deadline and expose a useful read recovery path', async () => {
  global.fetch = jest.fn().mockRejectedValue(new TypeError('offline'));
  await expect(listClasses()).rejects.toThrow('reload to retry');
  expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
test('uncertain entity writes never claim that the server did not save', async () => {
  global.fetch = jest.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
  await expect(createEntity('demo', 'value', {}, '')).rejects.toThrow('may already have been saved');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('server validation is readable and non-JSON errors retain HTTP status', async () => {
  global.fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:'Entities exist'}), {status:400}))
    .mockResolvedValueOnce(new Response('<html>unavailable</html>', {status:503}));
  await expect(deleteEntity('test')).rejects.toThrow('Entities exist');
  await expect(listClasses()).rejects.toThrow('Request failed (503)');
});
test('successful entity deletion accepts an empty response', async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response(null, {status:204}));
  await expect(deleteEntity('test')).resolves.toBeUndefined();
});

test('entity edits transmit the version originally shown to the user', async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response('{}', {status:200}));
  await updateEntity('test', {count:0,active:false}, 7);
  expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({fields:{'$."count"':0,'$."active"':false},expectedVersion:7});
});
