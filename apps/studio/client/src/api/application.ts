import { parseStudioApplication, type StudioApplication } from '@openhilo/studio-contracts';
import { readRunArtifact } from './run-artifacts';

export async function getStudioApplication(signal = new AbortController().signal): Promise<StudioApplication> {
  return readRunArtifact('/api/application', parseStudioApplication, signal);
}
