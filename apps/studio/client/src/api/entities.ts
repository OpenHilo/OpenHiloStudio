const BASE = '';

async function request(url: string, init?: RequestInit): Promise<Response> {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error(init?.method
    ? 'The server did not confirm this change. Reload before retrying; it may already have been saved.'
    : 'Unable to load data. Check the server connection and reload to retry.'); }
}

async function throwIfError(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
  throw new Error(typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`);
}

// ── Classes ───────────────────────────────────────────────────────────────

export async function listClasses(): Promise<Array<{ name: string; desc: string; tags: Record<string, string> }>> {
  const res = await request(`${BASE}/api/classes`);
  await throwIfError(res);
  return res.json() as ReturnType<typeof listClasses>;
}

export async function createClass(name: string, schema: unknown, desc: string, tags?: Record<string, string>): Promise<void> {
  const res = await request(`${BASE}/api/classes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, schema, desc, tags }),
  });
  await throwIfError(res);
}

export async function deleteClass(name: string): Promise<void> {
  const res = await request(`${BASE}/api/classes/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await throwIfError(res);
}

export async function getClass(name: string): Promise<{ desc: string; schema: unknown }> {
  const res = await request(`${BASE}/api/classes/${encodeURIComponent(name)}`);
  await throwIfError(res);
  return res.json() as ReturnType<typeof getClass>;
}

// ── Entities ──────────────────────────────────────────────────────────────

export async function listEntities(className: string): Promise<Array<{ id: string; name: string; desc: string; data: Record<string, unknown> | null; version: number | null; tags: Record<string, string>; readError?: string }>> {
  const res = await request(`${BASE}/api/entities?className=${encodeURIComponent(className)}`);
  await throwIfError(res);
  return res.json() as ReturnType<typeof listEntities>;
}

export async function getEntity(id: string): Promise<{ id: string; className: string; name: string; desc: string; data: Record<string, unknown>; version: number; tags: Record<string, string> }> {
  const res = await request(`${BASE}/api/entities/${encodeURIComponent(id)}`);
  await throwIfError(res);
  return res.json() as ReturnType<typeof getEntity>;
}

export async function createEntity(className: string, name: string, initData: Record<string, unknown>, desc: string, tags?: Record<string, string>): Promise<{ id: string }> {
  const res = await request(`${BASE}/api/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ className, name, initData, desc, tags }),
  });
  await throwIfError(res);
  // The API deliberately reuses an existing entity (200); creation is 201.
  // Keep the form open instead of discarding new inputs as a successful save.
  if (res.status === 200) throw new Error('An entity with this name already exists in this class. Your inputs were not saved. Choose another name, or cancel and edit the existing entity.');
  return res.json() as ReturnType<typeof createEntity>;
}

export async function updateEntity(id: string, fields: Record<string, unknown>, expectedVersion?: number): Promise<void> {
  // Forms edit literal top-level keys; quote them so dots, brackets and '$'
  // cannot be interpreted as traversal by the server's JSON-path patch API.
  const paths = Object.fromEntries(Object.entries(fields).map(([key, value]) => [`$.${JSON.stringify(key)}`, value]));
  const res = await request(`${BASE}/api/entities/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: paths, expectedVersion }),
  });
  await throwIfError(res);
}

export async function deleteEntity(id: string): Promise<void> {
  const res = await request(`${BASE}/api/entities/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await throwIfError(res);
}

// ── Tags ──────────────────────────────────────────────────────────────────

export interface TagDefinition {
  name: string;
  appliesTo: 'class' | 'entity' | 'intent';
  valueType: 'enum' | 'bool';
  allowedValues: string[];
  isOrdered: boolean;
  required: boolean;
  defaultValue: string | null;
  parentTag: string | null;
  parentAllowedValues?: Record<string, string[]>;
}

export async function getTagDefinitions(): Promise<TagDefinition[]> {
  const res = await request(`${BASE}/api/tag-definitions`);
  await throwIfError(res);
  return res.json() as ReturnType<typeof getTagDefinitions>;
}

export async function updateEntityTag(entityId: string, tagName: string, tagValue: string): Promise<void> {
  const res = await request(`${BASE}/api/entities/${encodeURIComponent(entityId)}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tagName, tagValue }),
  });
  await throwIfError(res);
}

// ── Intents ───────────────────────────────────────────────────────────────

export async function listIntents(): Promise<Array<{ name: string; desc: string; ittPath: string; relativeIttPath?: string }>> {
  const res = await request(`${BASE}/api/intents`);
  await throwIfError(res);
  return res.json() as ReturnType<typeof listIntents>;
}

export async function getIntentInfo(name: string): Promise<{ name: string; desc: string; inputs: Record<string, unknown>; outputs: Record<string, unknown> }> {
  const res = await request(`${BASE}/api/intents/${encodeURIComponent(name)}`);
  await throwIfError(res);
  return res.json() as ReturnType<typeof getIntentInfo>;
}
