import { validateRunInputWire } from '@openhilo/itt-contracts/run-inputs';

export function parseScheduleInputs(text: string): Record<string, string> {
  if (!text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Inputs must be valid JSON. Your input has not been saved.'); }
  try { validateRunInputWire(value); }
  catch { throw new Error('Inputs must be a JSON object with string values, for example {"count":"0"}.'); }
  return value as Record<string, string>;
}
