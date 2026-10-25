import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export class ConfigurationReadError extends Error {
  constructor(public readonly reason: 'invalid_json' | 'unreadable') {
    super(reason === 'invalid_json' ? 'configuration JSON is invalid' : 'configuration could not be read; no defaults were substituted');
    this.name = 'ConfigurationReadError';
  }
}

export interface FileConfigOptions<T extends object> {
  filePath: string;
  /** Decode and validate the complete stored representation. */
  parse: (raw: unknown) => T;
  /** Used only for ENOENT; return a fresh object for every invocation. */
  defaults: () => T;
  /** Preserve an existing storage envelope while returning the validated public type. */
  serialize?: (updated: T, original: unknown, patch: Partial<T>) => object;
}

/** Explicit-path JSON storage. No provider, application or home-directory defaults. */
export function createFileConfigStore<T extends object>(options: FileConfigOptions<T>) {
  if (!path.isAbsolute(options.filePath)) throw new Error('Configuration filePath must be absolute');
  function readStored(): { raw: unknown; missing: boolean } {
    let content: string;
    try { content = fs.readFileSync(options.filePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: options.defaults(), missing: true };
      throw new ConfigurationReadError('unreadable');
    }
    let raw: unknown;
    try { raw = JSON.parse(content); }
    catch { throw new ConfigurationReadError('invalid_json'); }
    return { raw, missing: false };
  }
  function load(): T {
    const stored = readStored();
    return stored.missing ? stored.raw as T : options.parse(stored.raw);
  }
  function save(patch: Partial<T>): T {
    const stored = readStored();
    const current = stored.missing ? stored.raw as T : options.parse(stored.raw);
    const updated = options.parse({ ...current, ...patch });
    const serialized = options.serialize ? options.serialize(updated, stored.raw, patch) : updated;
    if (options.serialize) options.parse(serialized); // Reject an unreadable envelope before replacing the file.
    const content = JSON.stringify(serialized, null, 2);
    const directory = path.dirname(options.filePath);
    const temporary = path.join(directory, `.${path.basename(options.filePath)}.${randomUUID()}.tmp`);
    fs.mkdirSync(directory, { recursive: true });
    let owned = false;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      owned = true;
      try { fs.writeFileSync(fd, content, 'utf8'); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, options.filePath);
    } finally {
      // Remove only this invocation's temporary file; never replace a failed write with defaults.
      if (owned) fs.rmSync(temporary, { force: true });
    }
    return updated;
  }
  return { load, save };
}
