import type {ExecutionPathStep} from '../lib/execution-path';

/** Only describe control outcomes supported by the recorded occurrence. */
export function ExecutionStepSummary({step}: {step:ExecutionPathStep}) {
  const condition = (step.row.outputs as {condition_result?:unknown} | undefined)?.condition_result;
  const outcome = step.iteration ? 'Enter loop body' : step.exit ? 'Exit loop' : step.transfer ? `${step.transfer} loop` : step.decision !== undefined ? `Take ${step.decision ? 'True' : 'False'} branch` : undefined;
  return <dl className="text-sm space-y-3 mb-5">
    <div><dt className="font-semibold">Status</dt><dd>{step.row.status === 'completed' ? 'Completed' : step.row.status}</dd></div>
    {step.iteration !== undefined && <div><dt className="font-semibold">Iteration</dt><dd>{step.iteration}</dd></div>}
    {typeof condition === 'boolean' && <div><dt className="font-semibold">Condition</dt><dd>{condition ? 'True' : 'False'}</dd></div>}
    {outcome && <div><dt className="font-semibold">Outcome</dt><dd>{outcome}</dd></div>}
    {step.row.description && <div><dt className="font-semibold">Description</dt><dd>{step.row.description}</dd></div>}
  </dl>;
}
