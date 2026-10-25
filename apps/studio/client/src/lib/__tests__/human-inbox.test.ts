import { submitInboxItem, humanTaskKey, validateInboxDraft } from '../human-inbox';
import { HumanRequestError, type HumanNodeDetail } from '../../api/human';
const node: HumanNodeDetail = { runId: 'r', intent: 'demo', workdir: '/tmp', nodeId: 'n', taskId: 'task1', prompt: 'Review', resolvedInputs: {}, suspendedAt: '', outputs: [{ name: 'ok', kind: 'boolean' }, { name: 'count', kind: 'number' }] };
const draft = { values: { ok: 'false', count: '0' } };
test('zero and false validate directly without a task decision; malformed output does not', () => {
  expect(validateInboxDraft(node, draft)).toEqual({});
  expect(validateInboxDraft(node, { ...draft, values: { ok: '', count: 'NaN' } })).toHaveProperty('ok');
  expect(validateInboxDraft({ ...node, outputs: [] }, { values: {} })).toEqual({});
});
test('loop identity cannot reuse an old answer even in the same run', async () => {
  const next = { ...node, taskId: 'task2' }, write = jest.fn();
  expect(humanTaskKey(node)).not.toBe(humanTaskKey(next));
  expect((await submitInboxItem(node, draft, { read: async () => next, write, id: () => 's' })).state).toBe('closed');
  expect(write).not.toHaveBeenCalled();
});
test('detail endpoint need not repeat the run ID already supplied in its URL', async () => {
  const { runId: _runId, ...detail } = node;
  const write = jest.fn().mockResolvedValue({ status: 'accepted' });
  const result = await submitInboxItem(node, draft, { read: async () => detail as HumanNodeDetail, write, id: () => 's' });
  expect(result.state).toBe('accepted'); expect(write).toHaveBeenCalledTimes(1);
});
test('lost acknowledgement freezes the exact submission for an idempotent retry', async () => {
  const write = jest.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValueOnce({ status: 'duplicate' });
  const ports = { read: async () => node, write, id: () => 's' };
  const first = await submitInboxItem(node, draft, ports);
  expect(first.state).toBe('unknown');
  const second = await submitInboxItem(node, { ...draft, submission: first.submission }, ports);
  expect(second.state).toBe('accepted');
  expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
  expect(write.mock.calls[0][1].outputs).toEqual({ ok: 'false', count: '0' });
});
test('a durable accepted answer is never replaced by the batch draft', async () => {
  const write = jest.fn();
  const acceptedSubmission = { taskId: 'task1', submissionId: 'other', outputs: {} };
  const result = await submitInboxItem(node, draft, { read: async () => ({ ...node, acceptedSubmission }), write, id: () => 's' });
  expect(result.state).toBe('accepted'); expect(write).not.toHaveBeenCalled();
});
test('known invalid answer remains editable; a stopped request is closed', async () => {
  const ports = { read: async () => node, write: jest.fn().mockRejectedValue(new HumanRequestError('Invalid output', 400)), id: () => 's' };
  expect((await submitInboxItem(node, draft, ports)).state).toBe('failed');
  ports.write.mockRejectedValue(new HumanRequestError('stale', 409));
  expect((await submitInboxItem(node, draft, ports)).state).toBe('closed');
});

test('new submissions contain only outputs and receipt identity', async () => {
  const write = jest.fn().mockResolvedValue({ status: 'accepted' });
  await submitInboxItem(node, draft, { read: async () => node, write, id: () => 's' });
  expect(write.mock.calls[0][1]).toEqual({ taskId: 'task1', submissionId: 's', outputs: draft.values });
});
