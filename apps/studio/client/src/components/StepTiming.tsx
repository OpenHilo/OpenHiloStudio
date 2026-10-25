import {elapsedTime} from '../lib/execution-time';
export function StepTiming({start, end, human = false}: {start?:number; end?:number; human?:boolean}) {
  const elapsed = elapsedTime(start, end);
  return <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted border-t border-line pt-3 mt-4">
    {start !== undefined && Number.isFinite(start) && <span>Started <time dateTime={new Date(start*1000).toISOString()}>{new Date(start*1000).toLocaleString()}</time></span>}
    {end !== undefined && Number.isFinite(end) && <span>Finished <time dateTime={new Date(end*1000).toISOString()}>{new Date(end*1000).toLocaleString()}</time></span>}
    {elapsed && <span title={human ? 'Includes time waiting for your response' : undefined}>Elapsed <strong className="font-medium text-ink">{elapsed}</strong></span>}
  </div>;
}
