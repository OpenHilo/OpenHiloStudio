import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { FilterConditions } from './run-history';
export interface SavedFilter { id: string; name: string; conditions: FilterConditions }

/** Preserves the legacy JSON array. Synchronous read/commit keeps same-process writes serialized. */
export class FilterService {
  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) throw new Error('Filter filePath must be absolute');
  }
  private read(): SavedFilter[] {
    let content: string;
    try { content = fs.readFileSync(this.filePath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const filters: unknown = JSON.parse(content);
    if (!Array.isArray(filters)) throw new Error('Invalid saved filter history');
    return filters as SavedFilter[];
  }
  private write(filters: SavedFilter[]) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    let owned = false;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600); owned = true;
      try { fs.writeFileSync(fd, JSON.stringify(filters, null, 2)); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filePath);
    } finally { if (owned) fs.rmSync(temporary, { force: true }); }
  }
  async list(): Promise<SavedFilter[]> { return this.read(); }
  async create(input: { name: string; conditions: FilterConditions }): Promise<SavedFilter> {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || !input.conditions || typeof input.conditions !== 'object' || Array.isArray(input.conditions)) {
      throw Object.assign(new Error('Filter name and conditions are required'), { statusCode: 400 });
    }
    const filters = this.read();
    const filter: SavedFilter = { id: randomUUID(), name: input.name, conditions: input.conditions };
    filters.push(filter); this.write(filters); return filter;
  }
  async delete(id: string): Promise<boolean> {
    const filters = this.read(), next = filters.filter(filter => filter.id !== id);
    if (next.length === filters.length) return false;
    this.write(next); return true;
  }
}
