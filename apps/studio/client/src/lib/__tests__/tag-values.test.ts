import type { TagDefinition } from '../../api/entities';
import { allowedTagValues, changeTagValue, effectiveTagValues, submittedTagValues } from '../tag-values';

const tag = (name: string, allowedValues: string[], extra: Partial<TagDefinition> = {}): TagDefinition => ({
  name, allowedValues, appliesTo: 'class', valueType: 'enum', isOrdered: false, required: false, defaultValue: null, parentTag: null, ...extra,
});
const defs = [
  tag('region', ['east', 'west']),
  tag('site', ['alpha', 'beta'], { parentTag: 'region', parentAllowedValues: { east: ['alpha'], west: ['beta'] } }),
  tag('room', ['one', 'two'], { parentTag: 'site', parentAllowedValues: { alpha: ['one'], beta: ['two'] } }),
];
test('arbitrary schema controls dependent choices without a built-in taxonomy', () => {
  expect(allowedTagValues(defs[1], { region: 'east' })).toEqual(['alpha']);
  expect(allowedTagValues(defs[1], {})).toEqual([]);
  expect(allowedTagValues(defs[1], { region: 'toString' })).toEqual([]);
});
test('changing a parent clears transitive children regardless of definition order', () => {
  const original = { region: 'east', site: 'alpha', room: 'one', unrelated: 'keep' };
  const next = changeTagValue([...defs].reverse(), original, 'region', 'west');
  expect(next).toEqual({ region: 'west', site: '', room: '', unrelated: 'keep' });
  expect(submittedTagValues(defs, next)).toEqual({ region: 'west', unrelated: 'keep' });
  expect(original.site).toBe('alpha');
});
test('optional defaults are submitted as displayed and respect dependent values', () => {
  const defaults = defs.map((d, i) => ({ ...d, defaultValue: ['east', 'alpha', 'one'][i] }));
  expect(effectiveTagValues([...defaults].reverse(), {})).toEqual({ region: 'east', site: 'alpha', room: 'one' });
  expect(submittedTagValues(defaults, { region: 'west' })).toEqual({ region: 'west' });
  expect(submittedTagValues(defaults, changeTagValue(defaults, {}, 'region', 'west'))).toEqual({ region: 'west' });
});
