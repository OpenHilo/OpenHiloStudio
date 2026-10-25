import type {SessionStep} from '../api/translate';
/** Published entry identities are module/export paths, never basenames alone. */
export function publishedWorkflows(step: Extract<SessionStep,{phase:'done'}>): string[] {
  if(!step.savedPaths?.length && !step.savedPath) return [];
  const prefix=step.savedPath.replace(/\/$/,'')+'/';
  const entries=step.entries ?? step.savedPaths?.filter(path=>path.startsWith(prefix)).map(path=>path.slice(prefix.length)) ?? [];
  return [...new Set(entries.filter(entry=>entry && !entry.startsWith('/') && !entry.includes('\\') && entry.split('/').every(part=>part && part!=='.'&&part!=='..')).map(entry=>entry.split('/').join('.')))];
}
