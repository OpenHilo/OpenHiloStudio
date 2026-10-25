jest.mock('../../api/translate', () => ({}));
import { needsPolling } from '../../hooks/useTranslate';

test('a question before the first heartbeat keeps polling for health and timeout', () => {
  expect(needsPolling({ phase: 'cc_waiting_for_answer', questionId: 'fast', question: 'Reply?' })).toBe(true);
  expect(needsPolling({ phase: 'error', message: 'expired', retryable: false })).toBe(false);
  expect(needsPolling(null)).toBe(false);
});
