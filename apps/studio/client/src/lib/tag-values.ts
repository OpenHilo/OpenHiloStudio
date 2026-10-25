import type { TagDefinition } from '../api/entities';

export function allowedTagValues(def: TagDefinition, values: Record<string, string>): string[] {
  if (!def.parentTag || !def.parentAllowedValues) return def.allowedValues;
  const parent = values[def.parentTag];
  const allowed = Object.prototype.hasOwnProperty.call(def.parentAllowedValues, parent)
    ? def.parentAllowedValues[parent] : [];
  return def.allowedValues.filter(value => allowed.includes(value));
}

/** Resolve optional defaults with the same dependency constraints shown by the form. */
export function effectiveTagValues(defs: TagDefinition[], values: Record<string, string>): Record<string, string> {
  const result = { ...values };
  for (let pass = 0; pass < defs.length; pass++) {
    let changed = false;
    for (const def of defs) {
      if (Object.prototype.hasOwnProperty.call(result, def.name) || def.required || !def.defaultValue) continue;
      if (allowedTagValues(def, result).includes(def.defaultValue)) {
        result[def.name] = def.defaultValue;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result;
}

/** A changed parent clears every dependent selection, including indirect descendants. */
export function changeTagValue(defs: TagDefinition[], values: Record<string, string>, name: string, value: string): Record<string, string> {
  const next = { ...values, [name]: value };
  const changed = new Set([name]);
  for (let pass = 0; pass < defs.length; pass++) {
    let added = false;
    for (const def of defs) {
      if (!def.parentTag || !changed.has(def.parentTag) || changed.has(def.name)) continue;
      // Explicit blank prevents a stale child default from reappearing after its parent changes.
      next[def.name] = '';
      changed.add(def.name);
      added = true;
    }
    if (!added) break;
  }
  return next;
}

export function submittedTagValues(defs: TagDefinition[], values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(effectiveTagValues(defs, values)).filter(([, value]) => value !== ''));
}
