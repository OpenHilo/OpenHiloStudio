import { resolveIntentPrefill, resolveRetryIntent } from '../intent-prefill';

describe('topic intent selection', () => {
  const intents = [{ name: 'qa.ping' }, { name: 'first.greeting' }, { name: 'second.greeting' }];
  it('resolves a unique entry name from history', () => {
    expect(resolveIntentPrefill(intents, 'ping')).toBe(intents[0]);
  });
  it('keeps exact qualified selection when entry names overlap', () => {
    expect(resolveIntentPrefill(intents, 'first.greeting')).toBe(intents[1]);
  });
  it('does not guess for ambiguous, missing, partial or different qualified names', () => {
    for (const hint of ['greeting', 'missing', 'greet', 'other.ping', '']) {
      expect(resolveIntentPrefill(intents, hint)).toBeUndefined();
    }
    expect(resolveIntentPrefill([{ name: 'qa.ping' }, { name: 'qa.ping' }], 'qa.ping')).toBeUndefined();
  });
});

describe('retry workflow identity', () => {
  const first = { name: 'first.echo', ittPath: '/fixture/intents/first/echo/echo.itt.impl.json', relativeIttPath: 'first/echo/echo.itt.impl.json' };
  const second = { name: 'second.echo', ittPath: '/fixture/intents/second/echo/echo.itt.impl.json', relativeIttPath: 'second/echo/echo.itt.impl.json' };
  it('resolves recorded absolute and library-relative paths without guessing by basename', () => {
    expect(resolveRetryIntent([first, second], first.ittPath)).toBe(first);
    expect(resolveRetryIntent([first, second], './first/echo/echo.itt.impl.json')).toBe(first);
    expect(resolveRetryIntent([first, second], second.relativeIttPath)).toBe(second);
    for (const invalid of ['echo.itt.impl.json', '../first/echo/echo.itt.impl.json', '/other/first/echo/echo.itt.impl.json', '']) expect(resolveRetryIntent([first, second], invalid)).toBeUndefined();
    expect(resolveRetryIntent([first, { ...second, relativeIttPath: first.relativeIttPath }], first.relativeIttPath)).toBeUndefined();
  });
});
