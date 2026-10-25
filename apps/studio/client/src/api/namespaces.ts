const BASE = '';

async function read<T>(url: string, validate: (value: unknown) => boolean, signal?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(15000);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : `Library request failed (HTTP ${res.status})`);
  }
  const value: unknown = await res.json();
  if (!validate(value)) throw new Error('The server returned invalid library data');
  return value as T;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');

export interface NamespaceIndex {
  namespace: string;
  entries: string[];
  intents: string[];
}

export interface IntentDetail {
  facet?: string;
  tags?: Record<string, string>;
  name: string;
  desc: string;
  hasTs: boolean;
  hasImpl: boolean;
  isEntry: boolean;
}

export interface NsDetail {
  namespace: string;
  entries: string[];
  intents: IntentDetail[];
}

export interface IttJson {
  leaf: Record<string, unknown>;
  impl: Record<string, unknown> | null;
  ts: string | null;
}

export async function listNamespaces(signal?: AbortSignal, facet?: string): Promise<NamespaceIndex[]> {
  return read(`${BASE}/api/namespaces${facet ? `?facet=${encodeURIComponent(facet)}` : ''}`, v => Array.isArray(v) && v.every(n => object(n) && typeof n.namespace === 'string' && strings(n.entries) && strings(n.intents)), signal);
}
export async function getNamespaceDetail(ns: string, signal?: AbortSignal): Promise<NsDetail> {
  return read(`${BASE}/api/namespaces/${encodeURIComponent(ns)}`, n => object(n) && typeof n.namespace === 'string' && strings(n.entries) && Array.isArray(n.intents) && n.intents.every((i: unknown) => object(i) && typeof i.name === 'string' && typeof i.desc === 'string' && (i.facet === undefined || typeof i.facet === 'string') && (i.tags === undefined || object(i.tags) && Object.values(i.tags).every(v => typeof v === 'string')) && ['hasTs', 'hasImpl', 'isEntry'].every(k => typeof i[k] === 'boolean')), signal);
}
export async function getIntentItt(ns: string, intent: string, signal?: AbortSignal): Promise<IttJson> {
  return read(`${BASE}/api/namespaces/${encodeURIComponent(ns)}/${encodeURIComponent(intent)}/itt`, v => object(v) && object(v.leaf) && (v.ts === null || typeof v.ts === 'string') && (v.impl === null || object(v.impl) && typeof v.impl.entry === 'string' && object(v.impl.nodes)), signal);
}
