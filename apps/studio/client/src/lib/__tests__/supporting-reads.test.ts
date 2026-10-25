import { getStudioCapabilities } from '../../api/studio-capabilities';
import { getStudioApplication } from '../../api/application';
import { getAiQuestions } from '../../api/ai-questions';
import { listFilters } from '../../api/filters';
import { suggestWorkdir } from '../../api/runs';
import { pollTranslate } from '../../api/translate';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });
const readers = [
  ['capabilities', () => getStudioCapabilities()],
  ['application', () => getStudioApplication()],
  ['questions', () => getAiQuestions('run-test')],
  ['filters', () => listFilters()],
  ['workdir', () => suggestWorkdir('qa')],
  ['generation', () => pollTranslate('qa')],
] as const;

test.each(readers)('%s read aborts a held request with a useful deadline error', async (_name, read) => {
  const deadline = new AbortController();
  jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  global.fetch = jest.fn((_url, options) => new Promise((_resolve, reject) => {
    if (!options?.signal) { reject(new Error('Request has no deadline')); return; }
    options.signal.addEventListener('abort', () => reject(options.signal!.reason));
  })) as typeof fetch;
  const pending = read();
  deadline.abort(new DOMException('Timed out', 'TimeoutError'));
  await expect(pending).rejects.toThrow('did not respond within 15 seconds');
});

test.each([
  ['capabilities', (signal: AbortSignal) => getStudioCapabilities(signal)],
  ['application', (signal: AbortSignal) => getStudioApplication(signal)],
  ['questions', (signal: AbortSignal) => getAiQuestions('run-test', signal)],
  ['filters', (signal: AbortSignal) => listFilters(signal)],
  ['workdir', (signal: AbortSignal) => suggestWorkdir('qa', signal)],
  ['generation', (signal: AbortSignal) => pollTranslate('qa', signal)],
] as const)('%s releases its connection when the owning view leaves', async (_name, read) => {
  const navigation = new AbortController();
  global.fetch = jest.fn((_url, options) => new Promise((_resolve, reject) => {
    if (!options?.signal) { reject(new Error('No cancellation signal')); return; }
    options.signal.addEventListener('abort', () => reject(options.signal!.reason));
  })) as typeof fetch;
  const pending = read(navigation.signal);
  navigation.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

 test('capabilities distinguish valid empty features from unreadable configuration', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ version: 1, features: [] }) })) as unknown as typeof fetch;
  await expect(getStudioCapabilities()).resolves.toEqual([]);
  for (const value of [{ version: 2, features: [] }, { version: 1, features: [true] }, null]) {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => value })) as unknown as typeof fetch;
    await expect(getStudioCapabilities()).rejects.toThrow('Invalid Studio capabilities');
  }
});
