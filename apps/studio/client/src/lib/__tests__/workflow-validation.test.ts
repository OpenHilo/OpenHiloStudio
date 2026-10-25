import { workflowInputErrors } from '../workflow-inputs';

test('workflow validation preserves valid falsy inputs while locating missing and malformed inputs', () => {
  expect(workflowInputErrors({ text: '', flag: false, count: 0, json: null }, { text: { kind: 'text' }, flag: { kind: 'boolean' }, count: { kind: 'number' }, json: { kind: 'json' } })).toEqual({});
  expect(Object.keys(workflowInputErrors({ count: '', dir: '', text: '' }, { count: { kind: 'number' }, dir: { kind: 'dir' }, text: { kind: 'text' } }))).toEqual(['count', 'dir']);
  expect(Object.keys(workflowInputErrors({ count: Infinity }, { count: { kind: 'number' } }))).toEqual(['count']);
});
