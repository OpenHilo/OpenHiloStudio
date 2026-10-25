import * as fs from 'fs';
import * as path from 'path';
import { resolveRunOpts } from '@openhilo/platform-services/worker-run-path';
import { IttValidator, type CFGITT } from '@openhilo/itt-contracts';
import { parseRunInputs } from '@openhilo/itt-contracts/run-inputs';
import { ScheduleValidationError, type Schedule } from '@openhilo/platform-services/schedule-service';

/** Preflight only: the worker still validates its actual snapshot at execution time. */
export function validateLocalSchedule(schedule: Readonly<Schedule>, intentsDir: string): void {
  if (!path.isAbsolute(schedule.ittPath) && (path.normalize(schedule.ittPath) === '..' || path.normalize(schedule.ittPath).startsWith(`..${path.sep}`))) throw new ScheduleValidationError('Relative workflow path must stay within the intent library');
  const resolved = resolveRunOpts(schedule.ittPath, intentsDir);
  if (!resolved) throw new ScheduleValidationError('Workflow file cannot be found in the intent library.');
  if (!path.isAbsolute(schedule.workdir)) throw new ScheduleValidationError('Workdir must be absolute');
  let workflow: CFGITT;
  try {
    if (!fs.statSync(resolved.entryFile).isFile()) throw new Error('not a file');
    workflow = JSON.parse(fs.readFileSync(resolved.entryFile, 'utf8'));
  } catch { throw new ScheduleValidationError('Workflow file cannot be read. Check that the workflow path exists and contains valid JSON.'); }
  try {
    const result = new IttValidator().validate(workflow);
    if (result.errors.length) throw new ScheduleValidationError(`Invalid workflow: ${result.errors.join('; ')}`);
  } catch (error) {
    if (error instanceof ScheduleValidationError) throw error;
    throw new ScheduleValidationError('Invalid workflow structure. Check the workflow file.');
  }
  try {
    const inputs = parseRunInputs(schedule.inputs, workflow.inputs ?? {}, schedule.inputEncoding);
    for (const [field, value] of Object.entries(inputs)) {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Invalid number run input: ${field}`);
    }
  } catch (error) { throw new ScheduleValidationError((error as Error).message); }
  let ancestor = schedule.workdir;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  try {
    if (!fs.statSync(ancestor).isDirectory()) throw new Error('not a directory');
    fs.accessSync(ancestor, fs.constants.W_OK);
  } catch { throw new ScheduleValidationError('Workdir must be a writable directory, or be inside a writable directory.'); }
}
