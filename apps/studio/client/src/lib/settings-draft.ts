import type { AiExecutionConfig } from '../api/config';

export type ProfileDraft = { name: string; provider: 'openai' | 'anthropic'; model: string; keyEnv: string; baseUrl: string; maxTokens: string };

export function profileDrafts(execution?: AiExecutionConfig): ProfileDraft[] {
  return execution?.adapter === 'sdk' ? Object.entries(execution.profiles).map(([name, profile]) => ({
    name, provider: profile.provider, model: profile.model, keyEnv: profile.api_key_env,
    baseUrl: profile.base_url ?? '', maxTokens: String(profile.max_output_tokens ?? ''),
  })) : [];
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, ordered(item)]));
  return value;
}

/** Compare editable values, independently of object key order and UI disclosure state. */
export function settingsDraftKey(adapter: string, execution: unknown, profiles: ProfileDraft[], defaultProfile: string, extension: unknown): string {
  const value = adapter === 'routed' ? execution : adapter === 'sdk' ? {
    defaultProfile,
    profiles: profiles.map(profile => ({ ...profile, model: profile.model.trim(), keyEnv: profile.keyEnv.trim(),
      baseUrl: profile.baseUrl.trim(), maxTokens: profile.maxTokens.trim() && Number.isFinite(Number(profile.maxTokens))
        ? Number(profile.maxTokens) : profile.maxTokens.trim(),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  } : extension;
  return JSON.stringify(ordered({ adapter, value }));
}
