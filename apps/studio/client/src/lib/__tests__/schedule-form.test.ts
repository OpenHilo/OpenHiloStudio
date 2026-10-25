import { buildScheduleCron, filterScheduleIntents } from '../schedule-form';
import { encodeWorkflowInputs } from '../workflow-inputs';

test('daily and selected weekdays map to existing five-field cron', () => {
  expect(buildScheduleCron('daily', '09:05', [], '')).toBe('5 9 * * *');
  expect(buildScheduleCron('weekly', '23:59', [5, 1, 3], '')).toBe('59 23 * * 1,3,5');
  expect(buildScheduleCron('advanced', '', [], ' */2 * * * * ')).toBe('*/2 * * * *');
});
test('incomplete or invalid presets cannot silently become a different schedule', () => {
  for (const time of ['', '24:00', '12:60', 'abc']) expect(() => buildScheduleCron('daily', time, [], '')).toThrow();
  expect(() => buildScheduleCron('weekly', '09:00', [], '')).toThrow();
  expect(() => buildScheduleCron('weekly', '09:00', [7], '')).toThrow();
});
test('search matches workflow name and description without changing identifiers', () => {
  const items = [{name:'memo.entry',desc:'备忘录'}, {name:'greeting.entry',desc:'Hello world'}];
  expect(filterScheduleIntents(items, 'HELLO')).toEqual([items[1]]);
  expect(filterScheduleIntents(items, '备忘')).toEqual([items[0]]);
  expect(filterScheduleIntents(items, 'missing')).toEqual([]);
});
test('schedule inputs retain zero, false, empty text and JSON strings with runtime encoding', () => {
  const schema = {count:{kind:'number'},active:{kind:'boolean'},label:{kind:'text'},meta:{kind:'json'}};
  expect(encodeWorkflowInputs({count:0,active:false,label:'',meta:'hello'},schema)).toEqual({count:'0',active:'false',label:'',meta:'"hello"'});
  expect(() => encodeWorkflowInputs({count:'oops',active:false,label:'',meta:{}},schema)).toThrow();
  expect(() => encodeWorkflowInputs({},schema)).toThrow();
});
