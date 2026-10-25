import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

/** Resolve an existing file within a configured data root, including symlink targets. */
export function containedFile(root: string, relative: string): string | undefined {
  const directory = path.resolve(root), file = path.resolve(directory, relative);
  if (file === directory || !file.startsWith(directory + path.sep) || !fs.existsSync(file)) return undefined;
  const actualRoot = fs.realpathSync(directory), actual = fs.realpathSync(file);
  return actual.startsWith(actualRoot + path.sep) && fs.statSync(actual).isFile() ? actual : undefined;
}

/** Module artifacts name their original source; legacy artifacts use one file per intent. */
export function workflowSourceFile(brainDir: string, namespace: string, name: string, ...metadata: unknown[]): string | undefined {
  let relative = path.join(...namespace.split('.'), `${name}.ts`);
  for (const value of metadata) {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'sourceFile')) {
      const source = (value as { sourceFile: unknown }).sourceFile;
      if (typeof source !== 'string' || path.isAbsolute(source)) return undefined;
      relative = source;
      break;
    }
  }
  const file = containedFile(brainDir, relative);
  if (!file) return;
  for (const value of metadata) {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'sourceTs')) {
      const expected = (value as { sourceTs: unknown }).sourceTs;
      const actual = 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      // Historical views must never present a newer edit as the source of an old run.
      if (expected !== actual) return;
    }
  }
  return file;
}
