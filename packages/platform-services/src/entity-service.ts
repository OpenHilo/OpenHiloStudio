import type { EntityStore, TagDefinition, TagCondition } from './entity-store';
import { EntityReadError } from './entity-store';
import { FailableError } from '@openhilo/runtime-contracts';

export class EntityService {
  constructor(private readonly em: EntityStore) {}

  listClasses(): { name: string; desc: string; tags: Record<string, string> }[] {
    return this.em.queryClasses();
  }

  getClass(name: string): { desc: string; schema: unknown } {
    return this.em.queryClassInfo(name);
  }

  defineClass(name: string, schema: unknown, desc: string, tags: Record<string, string> = {}): boolean {
    try {
      this.em.queryClassInfo(name);
      throw new FailableError(`Class '${name}' already exists`);
    } catch (err: unknown) {
      if (err instanceof FailableError && err.message.startsWith('Class not found')) {
        return this.em.defineClass(name, schema, desc, tags);
      }
      throw err;
    }
  }

  deleteClass(name: string): boolean {
    return this.em.deleteClass(name);
  }

  listEntities(className: string): { id: string; name: string; desc: string; data: Record<string, unknown> | null; version: number | null; tags: Record<string, string>; readError?: string }[] {
    return this.em.queryEntities(className).map(id => {
      try {
        const { name, desc, data, version, tags } = this.em.getEntity(id);
        return { id, name, desc, data, version, tags };
      } catch (error) {
        if (!(error instanceof EntityReadError)) throw error;
        return { id, name: id, desc: '', data: null, version: null, tags: {}, readError: error.message };
      }
    });
  }

  getEntity(entityId: string): { id: string; className: string; name: string; desc: string; data: Record<string, unknown>; version: number; tags: Record<string, string> } {
    return this.em.getEntity(entityId);
  }

  createEntity(className: string, name: string, initData: Record<string, unknown>, desc: string, tags: Record<string, string> = {}): { id: string; created: boolean } {
    this.em.queryClassInfo(className); // throws FailableError if not found
    return this.em.createEntity(className, name, initData, desc, tags);
  }

  // Field keys may be plain names or full JSON paths; the whole patch is atomic.
  updateEntity(entityId: string, fields: Record<string, unknown>, expectedVersion?: number): void {
    this.em.updateEntityFields(entityId, fields, expectedVersion);
  }

  deleteEntity(entityId: string): boolean {
    return this.em.deleteEntity(entityId);
  }

  getTagDefinitions(): TagDefinition[] {
    return this.em.getTagDefinitions();
  }

  updateEntityTag(entityId: string, tagName: string, tagValue: string): void {
    this.em.updateEntityTag(entityId, tagName, tagValue);
  }

  queryIntentsByTags(conditions: TagCondition[]): { name: string; desc: string; tags: Record<string, string> }[] {
    return this.em.queryIntentsByTags(conditions);
  }
}
