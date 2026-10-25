import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { SerializedSession } from './generation-session';
import type { SessionStorage } from './generation-server';
import { safeFile } from './publication';

/** Atomic local snapshots; callers coordinate sessions through one server driver. */
export function createFileSessionStorage<Snapshot extends SerializedSession = SerializedSession>(sessionsDir: string): SessionStorage<Snapshot> {
  if (!path.isAbsolute(sessionsDir)) throw new Error('Session storage directory must be an explicit absolute path');
  const writes = new Map<string, Promise<void>>();
  const fileFor = (id: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid session id');
    return safeFile(sessionsDir, `${id}/session.json`);
  };
  return {
    async restoreHistory(id) {
      const file = fileFor(id);
      await fs.unlink(path.join(path.dirname(file), '.history-deleted')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    },
    async removeHistory(id) {
      const file = fileFor(id);
      await writes.get(id);
      await fs.access(file);
      await fs.writeFile(path.join(path.dirname(file), '.history-deleted'), '', { flag: 'a' });
    },
    async list({ offset, limit }) {
      let directories;
      try { directories = await fs.readdir(sessionsDir, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], total: 0 }; throw error; }
      const entries: { id: string; updatedAt: string }[] = [];
      for (const directory of directories) {
        if (!directory.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(directory.name)) continue;
        try {
          const file = fileFor(directory.name);
          try { await fs.access(path.join(path.dirname(file), '.history-deleted')); continue; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const stat = await fs.stat(file);
          if (stat.isFile()) entries.push({ id: directory.name, updatedAt: stat.mtime.toISOString() });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      return { entries: entries.slice(offset, offset + limit), total: entries.length };
    },
    async load(id) {
      const file = fileFor(id);
      await writes.get(id);
      let text: string;
      try { text = await fs.readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      const data = JSON.parse(text) as Snapshot;
      if (!data || data.id !== id) throw new Error('Saved session identity does not match its storage key');
      return data;
    },
    async save(id, data) {
      const file = fileFor(id);
      if (data.id !== id) throw new Error('Session identity does not match its storage key');
      const text = JSON.stringify(data, null, 2);
      const write = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = path.join(path.dirname(file), `.session-${randomUUID()}.json`);
        try { await fs.writeFile(temporary, text); await fs.rename(temporary, file); }
        finally { await fs.unlink(temporary).catch(() => {}); }
      });
      writes.set(id, write);
      try { await write; } finally { if (writes.get(id) === write) writes.delete(id); }
    },
  };
}
