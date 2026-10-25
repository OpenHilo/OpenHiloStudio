import { HumanOutputError, parseHumanOutputs } from '@openhilo/itt-contracts/human-output';
import { readHumanNodeInfo } from './human-history';

/** Synchronous preflight so the supervisor claims ownership only after complete validation. */
export function validateHumanSubmission(runDir: string, humanOutput: unknown, humanNodeRunId?: string): void {
  if (humanNodeRunId !== undefined && (typeof humanNodeRunId !== 'string' || !humanNodeRunId.trim())) {
    throw Object.assign(new Error('humanNodeRunId must be a nonempty string'), { statusCode: 400 });
  }
  const pending = readHumanNodeInfo(runDir, '', true);
  if (!pending || (humanNodeRunId !== undefined && humanNodeRunId !== pending.nodeRunId)) {
    throw Object.assign(new Error('Human operation is no longer current; reload the pending task'), { statusCode: 409 });
  }
  try { parseHumanOutputs(humanOutput, Object.fromEntries(pending.outputs!.map(output => [output.name, output.kind]))); }
  catch (error) {
    if (error instanceof HumanOutputError) throw Object.assign(error, { statusCode: 400 });
    throw error;
  }
}
