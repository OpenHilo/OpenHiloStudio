import { type InputShape, type RunInputDefinition, validateInputShape } from '@openhilo/itt-contracts/run-inputs';
import { parseRunInputs, validateRunInputWire, type RunInputSchema } from '@openhilo/itt-contracts/run-inputs';
import type { ValueType } from '../components/SmartParamInput';

export function inferInputType(schema: unknown): ValueType {
  const raw = typeof schema === 'object' && schema !== null
    ? ((schema as Record<string, unknown>).kind ?? (schema as Record<string, unknown>).type ?? 'text')
    : schema;
  if (raw === 'boolean' || raw === 'bool') return 'boolean';
  if (raw === 'number' || raw === 'integer') return 'number';
  if (raw === 'json' || raw === 'object' || raw === 'array') return 'json';
  if (raw === 'file') return 'file';
  if (raw === 'dir') return 'dir';
  return 'text';
}

export function encodeWorkflowInputs(inputs: Record<string, unknown>, schema: Record<string, unknown>): Record<string, string> {
  for (const key of Object.keys(schema)) {
    const value = inputs[key], type = inferInputType(schema[key]);
    if (value === undefined || (type !== 'json' && value === null) || (type !== 'json' && type !== 'text' && value === '')) throw new Error(`${key}: required`);
  }
  for (const [key, value] of Object.entries(inputs)) {
    validateDraft(value, key);
    const shape = (schema[key] as RunInputDefinition | undefined)?.shape;
    if (shape) validateInputShape(value, shape, key);
  }
  const wire = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, inferInputType(schema[key]) === 'json' ? JSON.stringify(value) : String(value)]));
  validateRunInputWire(wire, 'typed-text-v1');
  parseRunInputs(wire, schema as RunInputSchema, 'typed-text-v1');
  return wire;
}

/** Uses the same wire contract as submission; empty text, false, zero and JSON null remain valid. */
export function workflowInputErrors(inputs: Record<string, unknown>, schema: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, definition] of Object.entries(schema)) {
    try { encodeWorkflowInputs({ [key]: inputs[key] }, { [key]: definition }); }
    catch (error) { errors[key] = (error as Error).message.replace(`${key}: `, ''); }
  }
  return errors;
}

export function focusWorkflowInput(container: Element | null, field: string, message?: string): void {
  const elements = Array.from(container?.querySelectorAll<HTMLElement>('input, textarea, select') ?? []);
  const path = message?.split(': ')[0];
  const input = elements.find(element => element.getAttribute('aria-label') === path) ?? elements
    .find(element => { const label = element.getAttribute('aria-label'); return label === field || label?.startsWith(`${field}.`) || label?.startsWith(`${field}[`); });
  input?.focus();
}

/** Do not let JSON serialization silently drop unfinished fields or coerce invalid numbers. */
function validateDraft(value: unknown, path: string): void {
  if (value === undefined) throw new Error(`${path}: required`);
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) throw new Error(`${path}: expected a finite number`);
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) validateDraft(item, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`);
}

export function initialShapeValue(shape: InputShape): unknown {
  switch (shape.type) {
    case 'text': return '';
    case 'boolean': return false;
    case 'null': return null;
    case 'literal': return shape.value;
    case 'array': return [];
    case 'object': return Object.fromEntries(Object.entries(shape.properties).filter(([,p]) => !p.optional).map(([key,p]) => [key, initialShapeValue(p.shape)]));
    case 'union': return initialShapeValue(shape.options[0]);
    case 'tuple': return shape.items.filter(item => !item.optional && !item.rest).map(item => initialShapeValue(item.shape));
    default: return undefined;
  }
}

export function initialWorkflowInput(definition: unknown): unknown {
  const shape = (definition as RunInputDefinition | undefined)?.shape;
  return initialShapeValue(shape ?? {type: inferInputType(definition)});
}
