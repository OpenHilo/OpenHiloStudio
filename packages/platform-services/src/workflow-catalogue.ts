import * as fs from 'fs';
import * as path from 'path';
import { FailableError } from '@openhilo/runtime-contracts';
import { qualifiedWorkflowName } from './worker-run-path';

/** Internal catalogue shared by direct and supervised runtime system calls. */
export interface WorkflowFile {
  name: string;
  desc: string;
  ittPath: string;
  relativeIttPath: string;
}
export function listWorkflowFiles(root: string): WorkflowFile[] {
  const found = new Map<string, WorkflowFile>();
  const scan = (dir: string, depth: number): void => {
    if (depth > 64) throw new FailableError('Workflow catalogue exceeds supported directory depth');
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(file, depth + 1); continue; }
      if (!entry.isFile() || !/\.itt(?:\.impl)?\.json$/.test(entry.name)) continue;
      const name = qualifiedWorkflowName(file, root);
      if (found.get(name)?.ittPath.endsWith('.itt.impl.json')) continue;
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        found.set(name, { name, desc: value.desc ?? value.description ?? '', ittPath: file,
          relativeIttPath: path.relative(root, file).split(path.sep).join('/') });
      } catch { /* A corrupt artifact cannot hide another valid workflow. */ }
    }
  };
  scan(root, 0);
  return [...found.values()];
}
export function resolveWorkflowFile(name: string, root: string): WorkflowFile {
  if (!name || name.split('.').some(part => !part || /[\\/\0]/.test(part))) throw new FailableError('Invalid intent name');
  const all = listWorkflowFiles(root);
  const exact = all.find(item => item.name === name);
  if (exact) return exact;
  const short = name.includes('.') ? [] : all.filter(item => item.name.split('.').at(-1) === name);
  if (short.length > 1) throw new FailableError(`Ambiguous intent name: ${name}. Use its namespace.`);
  if (short.length === 1) return short[0];
  throw new FailableError(`Intent not found: ${name}`);
}
