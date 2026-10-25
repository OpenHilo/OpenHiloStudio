import { parseScheduleInputs } from '../schedule-inputs';

test('blank optional schedule inputs become an empty map', () => {
  expect(parseScheduleInputs('   ')).toEqual({});
});

test.each(['{"broken":', 'null', '[]', '"value"', '{"count":0}', '{"flag":false}', '{"data":{}}'])('invalid schedule input %s is rejected instead of discarded', text => {
  expect(() => parseScheduleInputs(text)).toThrow();
});

test('wire text values retain zero, false, empty text, Unicode and serialized JSON', () => {
  const values = { count: '0', flag: 'false', empty: '', text: '中文\n"hello" 🌱', json: '{"items":[1,false]}' };
  expect(parseScheduleInputs(JSON.stringify(values))).toEqual(values);
});
