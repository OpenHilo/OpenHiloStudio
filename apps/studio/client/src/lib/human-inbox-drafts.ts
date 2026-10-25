import type { InboxDraft } from './human-inbox';

const prefix = 'intentorch.human-inbox.draft.v2.';
type StorageProvider = () => Storage;
const browserStorage: StorageProvider = () => globalThis.localStorage;
export const isInboxDraftStorageKey = (key: string | null) => key === null || key.startsWith(prefix);
const stringMap = (value: unknown): value is Record<string, string> => value !== null
  && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'string');

function readDraft(value: unknown, key: string): InboxDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(name => !['values', 'submission', 'attempted'].includes(name))) return null;
  const draft = value as InboxDraft;
  const identity: unknown = JSON.parse(key);
  if (!Array.isArray(identity) || identity.length !== 2 || !identity.every(v => typeof v === 'string' && v.length)) return null;
  if (!stringMap(draft.values)) return null;
  if (draft.attempted !== undefined && typeof draft.attempted !== 'boolean') return null;
  if (draft.attempted && !draft.submission) return null;
  if (draft.submission !== undefined) {
    const s = draft.submission;
    if (!s || Object.keys(s).some(name => !['taskId', 'submissionId', 'outputs'].includes(name))
      || draft.attempted !== true || s.taskId !== identity[1] || typeof s.submissionId !== 'string' || !s.submissionId || !stringMap(s.outputs)) return null;
    if (Object.keys(s.outputs).length !== Object.keys(draft.values).length || Object.entries(draft.values).some(([name, value]) => s.outputs[name] !== value)) return null;
  }
  return draft;
}

export function loadInboxDrafts(getStorage: StorageProvider = browserStorage): { drafts: Record<string, InboxDraft>; unavailable: boolean } {
  const drafts: Record<string, InboxDraft> = {};
  try {
    const storage = getStorage();
    for (let i = 0; i < storage.length; i++) {
      const storedKey = storage.key(i);
      if (!storedKey?.startsWith(prefix)) continue;
      const key = storedKey.slice(prefix.length);
      const raw = storage.getItem(storedKey);
      try {
        const draft: unknown = JSON.parse(raw ?? 'null');
        const restored = readDraft(draft, key);
        if (restored) drafts[key] = restored;
      } catch { /* A corrupt entry must not prevent other requests from restoring. */ }
    }
    return { drafts, unavailable: false };
  } catch { return { drafts, unavailable: true }; }
}

export function saveInboxDraft(key: string, draft: InboxDraft | null, getStorage: StorageProvider = browserStorage): boolean {
  try {
    const storage = getStorage();
    if (draft) storage.setItem(prefix + key, JSON.stringify(draft));
    else storage.removeItem(prefix + key);
    return true;
  } catch { return false; }
}
