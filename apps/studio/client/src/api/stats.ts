// platform/client/src/api/stats.ts
export interface DashboardStats { totalRuns: number; runningRuns: number; completedToday: number; failedRuns: number; pendingHumanNodes: number; }

export async function getStats(signal?: AbortSignal): Promise<DashboardStats> {
  const deadline = AbortSignal.timeout(15000);
  try {
    const res = await fetch('/api/stats', { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    if (!res.ok) throw new Error(`Statistics request failed (HTTP ${res.status}).`);
    const data = await res.json() as DashboardStats;
    if (!data || ['totalRuns', 'runningRuns', 'completedToday', 'failedRuns', 'pendingHumanNodes'].some(key => !Number.isSafeInteger(data[key as keyof DashboardStats]) || data[key as keyof DashboardStats] < 0)) throw new Error('Invalid dashboard statistics received.');
    return data;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof TypeError || (typeof error === 'object' && error !== null && 'name' in error && ['TimeoutError', 'AbortError'].includes(String(error.name)))) throw new Error('Unable to load dashboard statistics. Check the server connection and retry.');
    throw error;
  }
}
