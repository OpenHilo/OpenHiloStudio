// platform/server/worker/run-opts.ts
import * as path from 'path';
import * as fs from 'fs';

/**
 * Resolve an ittPath (absolute or relative) to an absolute entry file path + intent name.
 *
 * Relative paths are resolved in order:
 *   1. <intentsDir>/<rel>           — flat layout (primary)
 *   2. <intentsDir>/dev/<rel>       — legacy bucket layout (fallback)
 *   3. <intentsDir>/shared/<rel>    — legacy bucket layout (fallback)
 *
 * Returns null if the path cannot be resolved.
 */
export function resolveRunOpts(
  ittPath: string,
  intentsDir: string,
): { entryFile: string; intent: string } | null {
  if (path.isAbsolute(ittPath)) {
    const base = path.basename(ittPath);
    const intent = base.replace(/\.itt\.impl\.json$/, '').replace(/\.itt\.json$/, '');
    return { entryFile: ittPath, intent };
  }

  const flatCandidate = path.join(intentsDir, ittPath);
  const devCandidate = path.join(intentsDir, 'dev', ittPath);
  const sharedCandidate = path.join(intentsDir, 'shared', ittPath);

  let entryFile: string | null = null;
  if (fs.existsSync(flatCandidate)) entryFile = flatCandidate;
  else if (fs.existsSync(devCandidate)) entryFile = devCandidate;
  else if (fs.existsSync(sharedCandidate)) entryFile = sharedCandidate;

  if (!entryFile) return null;

  // Derive intent name from relative path (strip extensions)
  const intent = ittPath.replace(/\.itt\.impl\.json$/, '').replace(/\.itt\.json$/, '');
  return { entryFile, intent };
}

/** Resolve existing ancestors as well: historical source files may have been removed. */
function canonicalPath(file: string): string {
  let current = path.resolve(file);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...missing); } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(file);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Canonical library identity, shared by scheduler queries and run presentation. */
export function qualifiedWorkflowName(ittPath: string, intentsDir: string): string {
  const relative = path.relative(canonicalPath(intentsDir), canonicalPath(path.resolve(intentsDir, ittPath)));
  const name = path.basename(ittPath).replace(/\.itt(?:\.impl)?\.json$/, '');
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return name;
  const parts = relative.split(path.sep);
  parts.pop();
  if (parts.at(-1) === name) parts.pop();
  return [...parts, name].join('.');
}
