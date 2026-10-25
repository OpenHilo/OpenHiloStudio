import { updateConfig } from '../../api/config';
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

test('configuration validation keeps its specific explanation', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'ai_execution: model must be nonempty' }) })) as unknown as typeof fetch;
  await expect(updateConfig({})).rejects.toThrow('ai_execution: model must be nonempty');
});

test('storage failure explains recovery instead of an internal error label', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Internal Server Error' }) })) as unknown as typeof fetch;
  await expect(updateConfig({})).rejects.toThrow('Unable to save settings (HTTP 500). Check the server and try again.');
});

test('unreadable error response still explains the failed settings request', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token'); } })) as unknown as typeof fetch;
  await expect(updateConfig({})).rejects.toThrow('Unable to save settings (HTTP 502)');
});
