import { loadInboxDrafts, saveInboxDraft } from '../human-inbox-drafts';
import { humanTaskKey, submitInboxItem, type InboxDraft } from '../human-inbox';
import type { HumanNodeDetail } from '../../api/human';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); }, clear: () => data.clear() };
}
const node: HumanNodeDetail = { runId: 'r1', taskId: 'round1', nodeId: 'n', intent: 'test', workdir: '/tmp', prompt: '', resolvedInputs: {}, suspendedAt: '', outputs: [] };
const draft: InboxDraft = { values: { ok: 'false', count: '0', note: '草稿', data: '{invalid' } };
test('reload preserves partial answers independently across runs and loop rounds', () => {
  const storage = memoryStorage(), get = () => storage;
  const first = humanTaskKey(node), other = humanTaskKey({ ...node, runId: 'r2' });
  expect(saveInboxDraft(first, draft, get)).toBe(true);
  saveInboxDraft(other, { values: { note: 'other request' } }, get);
  const restored = loadInboxDrafts(get);
  expect(restored.drafts[first]).toEqual(draft);
  expect(restored.drafts[other].values).toEqual({ note: 'other request' });
  expect(restored.drafts[humanTaskKey({ ...node, taskId: 'round2' })]).toBeUndefined();
  expect(restored.unavailable).toBe(false);
});
test('clearing an old request cannot clear the next round or unrelated browser data', () => {
  const storage = memoryStorage(), get = () => storage;
  const first = humanTaskKey(node), next = humanTaskKey({ ...node, taskId: 'round2' });
  storage.setItem('unrelated', 'keep');
  saveInboxDraft(first, draft, get); saveInboxDraft(next, draft, get);
  saveInboxDraft(first, null, get);
  expect(loadInboxDrafts(get).drafts).toEqual({ [next]: draft });
  expect(storage.getItem('unrelated')).toBe('keep');
});
test('malformed saved data is ignored and denied or full storage is reported', () => {
  const storage = memoryStorage(), get = () => storage, key = humanTaskKey(node);
  saveInboxDraft(key, draft, get);
  const storedKey = storage.key(0)!;
  for (const value of ['not JSON', 'null', '{"decision":"confirm","values":{"ok":false}}', JSON.stringify({ ...draft, submission: { taskId: 'wrong' } })]) {
    storage.setItem(storedKey, value);
    expect(loadInboxDrafts(get).drafts).toEqual({});
  }
  const denied = () => { throw Error('Storage denied'); };
  expect(loadInboxDrafts(denied).unavailable).toBe(true);
  expect(saveInboxDraft(key, draft, denied)).toBe(false);
  storage.setItem = () => { throw Error('Quota exceeded'); };
  expect(saveInboxDraft(key, draft, get)).toBe(false);
  storage.getItem = () => { throw Error('Read denied'); };
  expect(loadInboxDrafts(get).unavailable).toBe(true);
});
test('the exact submission is durable BEFORE dispatch, so a reload retries the same answer and ID', async () => {
  const storage = memoryStorage(), get = () => storage, key = humanTaskKey(node);
  const write = jest.fn(async () => {
    expect(loadInboxDrafts(get).drafts[key].attempted).toBe(true);
    expect(loadInboxDrafts(get).drafts[key].submission?.submissionId).toBe('original');
    throw Error('Lost acknowledgement');
  });
  const result = await submitInboxItem(node, draft, { read: async () => node, write, id: () => 'original' }, saved => { saveInboxDraft(key, saved, get); });
  expect(result.state).toBe('unknown');
  const restored = loadInboxDrafts(get).drafts[key];
  const retry = jest.fn().mockResolvedValue({ status: 'duplicate' });
  await submitInboxItem(node, restored, { read: async () => node, write: retry, id: () => 'must-not-change' });
  expect(retry.mock.calls[0]).toEqual(write.mock.calls[0]);
});
test('default storage survives a closed tab and clears an accepted request across new tabs', () => {
  const local = memoryStorage(), session = memoryStorage(), key = humanTaskKey(node);
  const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
    saveInboxDraft(key, draft);
    session.clear(); // Closing the old tab destroys its session storage.
    expect(loadInboxDrafts().drafts[key]).toEqual(draft);
    saveInboxDraft(key, null);
    expect(loadInboxDrafts().drafts[key]).toBeUndefined();
  } finally {
    for (const [name, descriptor] of [['localStorage', oldLocal], ['sessionStorage', oldSession]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
test('old-format browser drafts are ignored without migrating or deleting them', () => {
  const storage = memoryStorage(), key = humanTaskKey(node);
  storage.setItem('intentorch.human-inbox.draft.v1.' + key, JSON.stringify({ decision: 'reject', values: {}, attempted: true }));
  expect(loadInboxDrafts(() => storage).drafts).toEqual({});
  expect(storage.length).toBe(1);
  saveInboxDraft(key, draft, () => storage);
  expect(loadInboxDrafts(() => storage).drafts).toEqual({ [key]: draft });
});
test('unexpected fields and attempted drafts without a receipt cannot restore', () => {
  const storage = memoryStorage(), key = humanTaskKey(node);
  for (const invalid of [{ ...draft, decision: 'confirm' }, { ...draft, attempted: true }, { ...draft, attempted: true, submission: { taskId: 'round1', submissionId: 's', outputs: draft.values, decision: 'confirm' } }]) {
    storage.setItem('intentorch.human-inbox.draft.v2.' + key, JSON.stringify(invalid));
    expect(loadInboxDrafts(() => storage).drafts).toEqual({});
  }
});
