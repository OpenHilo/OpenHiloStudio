const BASE = '/api/config';
import type { AiExecutionConfig } from '@openhilo/studio-contracts/ai-config';
export type { AiExecutionConfig, SdkProfileConfig } from '@openhilo/studio-contracts/ai-config';

export interface IttConfig extends Record<string, unknown> {
  ai_execution?: AiExecutionConfig;
  saved_ai_execution?: AiExecutionConfig;
  configuration_revision?: string;
  codex_models?: { model: string; efforts: string[] }[];
  configuration_status?: { activation: 'restart'; restart_required: boolean; editable?: boolean };
}

export async function getConfig(signal?: AbortSignal): Promise<IttConfig> {
  const deadline = AbortSignal.timeout(15000);
  try {
    const res = await fetch(BASE, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    if (!res.ok) throw new Error(`Unable to load settings (HTTP ${res.status}).`);
    return await res.json() as IttConfig;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof TypeError || (typeof error === 'object' && error !== null && 'name' in error && ['TimeoutError', 'AbortError'].includes(String(error.name)))) throw new Error('Unable to load settings. Check the server connection and retry.');
    throw error;
  }
}

export async function updateConfig(cfg: Partial<IttConfig>): Promise<IttConfig> {
  const res = await fetch(BASE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    if (res.status < 500 && typeof body?.error === 'string') throw new Error(body.error);
    throw new Error(`Unable to save settings (HTTP ${res.status}). Check the server and try again.`);
  }
  return res.json() as Promise<IttConfig>;
}
