import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { withStableArtifactTree } from './publication';
import type { CFGITT } from '@openhilo/itt-contracts';

// ── Public helpers (exported for testing) ────────────────────────────────────

export function parseCallee(
  callee: string,
  imports: Record<string, string>,
): { intentName: string; nsPath: string } {
  const expanded = imports[callee] ?? callee;
  const dotIdx = expanded.lastIndexOf('.');
  if (dotIdx === -1) {
    return { intentName: expanded, nsPath: '' };
  }
  const intentName = expanded.slice(dotIdx + 1);
  // nsPath uses dot-notation to match flat Brain directory names (e.g. "superpowers.brainstorming")
  return { intentName, nsPath: expanded.slice(0, dotIdx) };
}

export function extractCallees(itt: CFGITT): Array<{ callee: string; required: boolean }> {
  const seen = new Map<string, boolean>();
  for (const node of Object.values(itt.nodes)) {
    if (node.type === 'call' && node.callee) {
      if (node.executor === 'intent') {
        seen.set(node.callee, true);   // intent callee: must exist
      } else if (node.executor === 'ai') {
        // ai callee: optional — may have an impl ITT for sub-intent dispatch,
        // but AI nodes also run the AI provider directly without a Brain file.
        if (!seen.has(node.callee)) seen.set(node.callee, false);
      }
    }
  }
  return Array.from(seen.entries()).map(([callee, required]) => ({ callee, required }));
}

export function getNamespaceRoot(filePath: string, namespace: string): string {
  const dir = path.dirname(filePath);
  if (!namespace) return dir;
  const depth = namespace.split('.').length;
  let root = dir;
  for (let i = 0; i < depth; i++) root = path.dirname(root);
  return root;
}

/**
 * Find ITT files for an intent using the flat namespace layout.
 *
 * With namespace: intents/<ns>/<name>/<name>.itt[.impl].json
 * No namespace:   intents/<name>/<name>.itt[.impl].json
 * Also searches the flat root as fallback when nsPath is non-empty.
 *
 * @param intentName  e.g. "generateDocs"
 * @param nsPath      e.g. "analytics" or "analytics.utils" or "" (flat root)
 * @param intentsDir  absolute path to the intents/ directory ($ITT_HOME/intents)
 */
export function findITTFiles(
  intentName: string,
  nsPath: string,
  intentsDir: string,
): string[] {
  const physNs = nsPath ? nsPath.split('.').join(path.sep) : '';
  const candidates: string[] = [];

  if (physNs) {
    candidates.push(
      path.join(intentsDir, physNs, intentName, `${intentName}.itt.impl.json`),
      path.join(intentsDir, physNs, intentName, `${intentName}.itt.json`),
    );
  }
  // Flat root (no namespace, or fallback when namespaced path not found)
  candidates.push(
    path.join(intentsDir, intentName, `${intentName}.itt.impl.json`),
    path.join(intentsDir, intentName, `${intentName}.itt.json`),
  );

  return candidates.filter(fs.existsSync);
}

/**
 * Resolve an intent name to its canonical Brain path using the flat layout.
 * Returns the absolute path (.itt.impl.json preferred over .itt.json)
 * or null if not found.
 *
 * @param intentName  e.g. "generateDocs"
 * @param nsPath      e.g. "analytics" or "" (flat root)
 * @param ittHome     explicit application data root
 */
export function resolveBrainPath(intentName: string, nsPath: string, ittHome: string): string | null {
  const intentsDir = path.join(ittHome, 'intents');
  const physNs = nsPath ? nsPath.split('.').join(path.sep) : '';
  const candidates: string[] = physNs ? [
    path.join(intentsDir, physNs, intentName, `${intentName}.itt.impl.json`),
    path.join(intentsDir, physNs, intentName, `${intentName}.itt.json`),
  ] : [];
  candidates.push(
    path.join(intentsDir, intentName, `${intentName}.itt.impl.json`),
    path.join(intentsDir, intentName, `${intentName}.itt.json`),
  );
  return candidates.find(c => fs.existsSync(c)) ?? null;
}

export interface SnapshotterConfig {
  entryFile: string;    // absolute path to entry ITT file
  snapshotDir: string;  // destination directory (already exists)
  ittHome: string;      // explicit application data root; no global default
  /** Module artifacts retain qualified call identities; old flat snapshots remain the default. */
  layout?: 'legacy' | 'qualified';
}

export class Snapshotter {
  private readonly ittHome: string;
  private readonly copiedDestSources = new Map<string, string>();

  constructor(private readonly cfg: SnapshotterConfig) {
    if (typeof cfg.ittHome !== 'string' || !cfg.ittHome.trim()) throw new Error('Snapshotter requires an explicit ittHome');
    this.ittHome = cfg.ittHome;
  }

  collect(): void {
    withStableArtifactTree(path.join(this.ittHome, 'intents'), () => this.collectStable());
  }

  private collectStable(): void {
    const queue: string[] = [path.resolve(this.cfg.entryFile)];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);

      const itt = JSON.parse(fs.readFileSync(file, 'utf-8')) as CFGITT;
      const qualified = [itt.namespace, itt.name].filter(Boolean).join('.');
      if (this.cfg.layout === 'qualified' && !/^[\p{ID_Start}_$][\p{ID_Continue}$-]*(\.[\p{ID_Start}_$][\p{ID_Continue}$-]*)*$/u.test(qualified))
        throw new Error(`Snapshotter: invalid qualified workflow identity: ${qualified}`);
      const suffix = file.endsWith('.itt.impl.json') ? '.itt.impl.json' : '.itt.json';
      const filename = this.cfg.layout === 'qualified' ? qualified + suffix : path.basename(file);
      const dest = path.join(this.cfg.snapshotDir, filename);
      const previousSource = this.copiedDestSources.get(dest);
      if (previousSource && previousSource !== file) {
        throw new Error(
          `Snapshotter: basename collision for "${path.basename(file)}": ` +
          `"${previousSource}" and "${file}" both map to "${dest}"`,
        );
      }
      fs.copyFileSync(file, dest);
      this.copyVerifiedSource(file, itt);
      this.copiedDestSources.set(dest, file);
      // Legacy callers still use basenames; current compiler output also uses
      // namespace-qualified callees. Retain both identities in new snapshots.
      if (this.cfg.layout !== 'qualified' && itt.namespace && /^[\p{ID_Start}_$][\p{ID_Continue}$-]*(\.[\p{ID_Start}_$][\p{ID_Continue}$-]*)*$/u.test(qualified)) {
        const alias = path.join(this.cfg.snapshotDir, qualified + suffix);
        const previousAlias = this.copiedDestSources.get(alias);
        if (previousAlias && previousAlias !== file) throw new Error(`Snapshotter: identity collision for "${qualified}"`);
        fs.copyFileSync(file, alias);
        this.copiedDestSources.set(alias, file);
      }
      if (this.cfg.layout === 'qualified') {
        // Runtime's public start API addresses the root by its original basename.
        // Dependencies use qualified filenames and never acquire ambiguous aliases.
        if (file === path.resolve(this.cfg.entryFile)) fs.copyFileSync(file, path.join(this.cfg.snapshotDir, path.basename(file)));
        if (file.endsWith('.itt.impl.json')) {
          const sourceMap = file.replace(/\.itt\.impl\.json$/, '.source-map.json');
          if (fs.existsSync(sourceMap)) fs.copyFileSync(sourceMap, path.join(this.cfg.snapshotDir, `${qualified}.source-map.json`));
        }
      }

      // Parse and recurse
      const imports = itt.imports ?? {};
      const intentsDir = path.join(this.ittHome, 'intents');

      for (const { callee, required } of extractCallees(itt)) {
        const { intentName, nsPath } = parseCallee(callee, imports);
        const found = findITTFiles(intentName, nsPath, intentsDir);
        if (found.length === 0) {
          if (required) {
            throw new Error(
              `Snapshotter: cannot find ITT for callee "${callee}" (intentName="${intentName}", nsPath="${nsPath}")`,
            );
          }
          // optional (ai executor) — callee runs the AI provider directly, no Brain file needed
          continue;
        }
        for (const f of found) {
          if (!visited.has(f)) queue.push(f);
        }
      }
    }
  }

  private copyVerifiedSource(file: string, metadata: unknown): void {
    const value = metadata as { sourceTs?: unknown; sourceFile?: unknown };
    if (typeof value.sourceTs !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.sourceTs)) return;
    const brain = path.join(this.ittHome, 'brain');
    const artifactRelative = path.relative(path.join(this.ittHome, 'intents'), file);
    const relative = value.sourceFile ?? path.join(path.dirname(path.dirname(artifactRelative)), path.basename(file).replace(/\.itt(?:\.impl)?\.json$/, '.ts'));
    if (typeof relative !== 'string' || path.isAbsolute(relative)) return;
    const source = path.resolve(brain, relative);
    if (!source.startsWith(path.resolve(brain) + path.sep) || !fs.existsSync(source)) return;
    const actual = fs.realpathSync(source);
    if (!actual.startsWith(fs.realpathSync(brain) + path.sep) || !fs.statSync(actual).isFile()) return;
    const contents = fs.readFileSync(actual);
    const hash = createHash('sha256').update(contents).digest('hex');
    // Source edits can precede publication. Preserve only bytes belonging to
    // the compiled artifact, never label a newer edit as this run's source.
    if (value.sourceTs !== `sha256:${hash}`) return;
    const directory = path.join(this.cfg.snapshotDir, '.sources');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${hash}.ts`), contents);
  }
}
