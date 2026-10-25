import { createClientId } from './client-id';
import type { HumanSubmission } from '@openhilo/human-contracts';
import { parseHumanOutputValue } from '@openhilo/itt-contracts/human-output';
import type { ValueType } from '@openhilo/itt-contracts';
import { getHumanNode, HumanRequestError, submitHumanTask, type HumanNodeDetail } from '../api/human';

export interface InboxDraft { values: Record<string, string>; submission?: HumanSubmission; attempted?: boolean }
export interface InboxResult { state: 'accepted' | 'failed' | 'unknown' | 'closed'; message: string; submission?: HumanSubmission }
export const humanTaskKey = (node: Pick<HumanNodeDetail, 'runId' | 'taskId'>) => JSON.stringify([node.runId, node.taskId]);
export function validateInboxDraft(node: HumanNodeDetail, draft: InboxDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const output of node.outputs) {
    try { parseHumanOutputValue(draft.values[output.name] ?? '', output.kind as ValueType, output.name); }
    catch (error) { errors[output.name] = (error as Error).message; }
  }
  return errors;
}
interface Ports {
  read: typeof getHumanNode;
  write(runId: string, submission: HumanSubmission): Promise<{ status: string; message?: string }>;
  id(): string;
}
const ports: Ports = { read: getHumanNode, write: submitHumanTask, id: () => createClientId() };

export async function submitInboxItem(node: HumanNodeDetail, draft: InboxDraft, api: Ports = ports, beforeDispatch?: (draft: InboxDraft) => void): Promise<InboxResult> {
  let dispatched = false, submission = draft.submission;
  try {
    const current = await api.read(node.runId);
    // The detail endpoint identifies the run through its URL, not its JSON body.
    if (!node.taskId || current.taskId !== node.taskId) return { state: 'closed', message: 'This request is no longer current. Review the new request separately.' };
    if (current.acceptedSubmission) return { state: 'accepted', message: 'An answer is already saved. Check continuation in the task details.' };
    if (!submission) {
      const errors = validateInboxDraft(current, draft);
      if (Object.keys(errors).length) return { state: 'failed', message: Object.values(errors).join(' ') };
      submission = { taskId: node.taskId, submissionId: api.id(), outputs: { ...draft.values } };
    }
    // Persist the immutable answer before the network write, so retries survive closing this page.
    beforeDispatch?.({ ...draft, submission, attempted: true });
    dispatched = true;
    const receipt = await api.write(node.runId, submission);
    if (!['accepted', 'duplicate'].includes(receipt.status)) return { state: receipt.status === 'invalid' ? 'failed' : 'closed', message: receipt.message ?? `Submission ${receipt.status}. Refresh the request.` };
    return { state: 'accepted', message: 'Answer accepted. The workflow may now continue; this does not mean it has finished.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HumanRequestError && [400, 404, 409].includes(error.status)) return { state: dispatched && error.status === 400 ? 'failed' : 'closed', message };
    return dispatched || submission || draft.attempted
      ? { state: 'unknown', message: 'The server did not confirm the outcome. Your original answer is locked; check the run or retry that same answer.', submission }
      : { state: 'failed', message };
  }
}
