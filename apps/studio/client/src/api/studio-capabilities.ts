import { readRunArtifact } from './run-artifacts';

export function getStudioCapabilities(signal = new AbortController().signal): Promise<string[]> {
  return readRunArtifact('/api/studio-capabilities', value => {
    const data = value as { version?: unknown; features?: unknown } | null;
    if (!data || data.version !== 1 || !Array.isArray(data.features) ||
        !data.features.every(feature => typeof feature === 'string')) {
      throw new Error('Invalid Studio capabilities. Try loading optional pages again.');
    }
    return data.features as string[];
  }, signal);
}
