// platform/client/src/api/schedules.ts
export interface ScheduleAttempt { startedAt: string; status: 'pending' | 'launched' | 'failed' | 'unknown'; finishedAt?: string; runId?: string; error?: string; }
export interface Schedule { lastAttempt?: ScheduleAttempt; id: string; name: string; cron: string; ittPath: string; workdir: string; inputs: Record<string, string>; inputEncoding?: 'typed-text-v1'; enabled: boolean; lastRunId?: string; lastRunAt?: string; nextRunAt?: string; timeZone?: string; flexible?: boolean; assignedCron?: string; }

async function request(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); }
  catch {
    throw new Error(init?.method
      ? 'The server did not confirm this change. Refresh the list before trying again; it may already have been saved.'
      : 'Unable to load schedules. Check the server connection and try Refresh.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : `Schedule request failed (${response.status})`);
  }
  return response;
}

export async function listSchedules(): Promise<Schedule[]> {
  const res = await request('/api/schedules');
  return res.json() as Promise<Schedule[]>;
}

export async function getScheduleMeta(): Promise<{ timeZone: string | null }> {
  const response = await request('/api/schedules/meta');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('timeZone' in body)
    || (body.timeZone !== null && typeof body.timeZone !== 'string')) {
    throw new Error('Unable to read the scheduler time zone. Try Refresh.');
  }
  return { timeZone: body.timeZone };
}

export async function createSchedule(body: Omit<Schedule, 'id' | 'lastRunAt' | 'lastRunId' | 'nextRunAt' | 'timeZone' | 'lastAttempt'>): Promise<Schedule> {
  const res = await request('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json() as Promise<Schedule>;
}

export async function patchSchedule(id: string, updates: Partial<Schedule>): Promise<Schedule> {
  const res = await request(`/api/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
  return res.json() as Promise<Schedule>;
}

export async function deleteSchedule(id: string): Promise<void> {
  await request(`/api/schedules/${id}`, { method: 'DELETE' });
}
