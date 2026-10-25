// Exercise identity/storage behavior independently of browser timing; real UI evidence
// additionally covers paste, navigation, reload and accepted submission.
let mockState: unknown;
jest.mock('react', () => ({ useState: (initialize: () => unknown) => {
  if (mockState === undefined) mockState = initialize();
  return [mockState, (next: unknown) => { mockState = typeof next === 'function' ? next(mockState) : next; }];
} }));
import { useQuestionDraft } from '../../hooks/useQuestionDraft';

let stored: Map<string, string>;
beforeEach(() => {
  mockState = undefined; stored = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: jest.fn((key: string) => stored.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => { stored.set(key, value); }),
    removeItem: jest.fn((key: string) => { stored.delete(key); }),
  } });
});
afterEach(() => { Reflect.deleteProperty(globalThis, 'sessionStorage'); });

test('multiline drafts survive remount and are isolated by session and question', () => {
  const answer = '  中文 🌱\n"quote" C:\\qa\n  ';
  useQuestionDraft('A', 'q1').setText(answer);
  useQuestionDraft('A', 'q1').setSelectedOption('yes');
  expect(useQuestionDraft('B', 'q1').text).toBe('');
  expect(useQuestionDraft('A', 'q2').text).toBe('');
  mockState = undefined;
  expect(useQuestionDraft('A', 'q1')).toMatchObject({ text: answer, selectedOption: 'yes' });
});

test('an old receipt clears only its own draft without erasing the next question', () => {
  useQuestionDraft('A', 'q1').setText('first');
  const first = useQuestionDraft('A', 'q1');
  useQuestionDraft('A', 'q2').setText('second');
  first.clear();
  expect(useQuestionDraft('A', 'q2').text).toBe('second');
  expect(useQuestionDraft('A', 'q1').text).toBe('');
  expect(stored.size).toBe(1);
});

test('unavailable storage reports the limitation without discarding current-page input', () => {
  (sessionStorage.getItem as jest.Mock).mockImplementation(() => { throw new Error('blocked'); });
  (sessionStorage.setItem as jest.Mock).mockImplementation(() => { throw new Error('quota'); });
  useQuestionDraft('A', 'q').setText('retain me');
  expect(useQuestionDraft('A', 'q')).toMatchObject({ text: 'retain me', unavailable: true });
});

test('corrupted stored values cannot become answer text or selected options', () => {
  const key = 'intentorch.answer.' + JSON.stringify(['A', 'q']);
  for (const value of ['null', '{"text":42,"selectedOption":null}', '{"text":"x","selectedOption":{}}', '{']) {
    stored.set(key, value); mockState = undefined;
    expect(useQuestionDraft('A', 'q').text).toBe('');
    expect(useQuestionDraft('A', 'q').selectedOption).toBeNull();
  }
});
