import { createToolHost, type RegisteredTool } from '@openhilo/tool-host';
import type { EntityStore } from '../entity-store';
import { createPlatformReadTools } from './reads';

function objectArg(value: unknown, field: string): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`define_class: ${field} must be an object`);
  return parsed as Record<string, unknown>;
}

/** Platform composition owns both writes and reads, independent of the AI provider. */
export function createPlatformTools(store: EntityStore, options: { intentsDir?: string; allowDefineClass?: boolean } = {}): RegisteredTool[] {
  const tools = createPlatformReadTools(store, options.intentsDir);
  if (options.allowDefineClass) tools.push({
    name: 'define_class',
    description: 'Register an entity class immediately in platform storage. schema is a flat field-name to value-kind map, e.g. {"content":"text","count":"number","done":"boolean","details":"json"}, not a JSON Schema document. className and desc must be non-empty; tags is an object of existing tag values ({} when none are needed). Returns {ok:true} or {ok:false,existingSchema} when the name already exists; inspect the existing schema rather than assuming it was replaced.',
    inputSchema: {
      type: 'object', properties: {
        className: { type: 'string', minLength: 1, pattern: '\\S' },
        schema: { oneOf: [{ type: 'object' }, { type: 'string' }] },
        desc: { type: 'string', minLength: 1, pattern: '\\S' },
        tags: { oneOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'string' }] },
      }, required: ['className', 'schema', 'desc', 'tags'], additionalProperties: false,
    },
    async handler(args) {
      const schema = objectArg(args.schema, 'schema');
      const tags = objectArg(args.tags, 'tags');
      if (!Object.values(tags).every(value => typeof value === 'string')) throw new Error('define_class: tag values must be strings');
      try {
        store.defineClass(args.className as string, schema, args.desc as string, tags as Record<string, string>);
        return { ok: true };
      } catch (error) {
        if (error instanceof Error && error.message.includes('already exists')) {
          return { ok: false, existingSchema: store.queryClassInfo(args.className as string) };
        }
        throw error;
      }
    },
  });
  return tools;
}

export function createPlatformToolHost(store: EntityStore, options: { intentsDir?: string; allowDefineClass?: boolean } = {}) {
  return createToolHost(createPlatformTools(store, options));
}
