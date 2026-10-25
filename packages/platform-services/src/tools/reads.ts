import * as fs from 'fs';
import * as path from 'path';
import { createToolHost, type RegisteredTool } from '@openhilo/tool-host';
import type { EntityStore } from '../entity-store';

export function createPlatformReadTools(em: EntityStore, intentsDir?: string): RegisteredTool[] {
  // Copy native SQLite row arrays into this realm before the strict JSON boundary.
  const tools: RegisteredTool[] = [
    {
      name: 'queryClasses',
      description: 'List all defined entity class names.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => Array.from(em.queryClasses(), c => c.name),
    },
    {
      name: 'queryClassInfo',
      description: 'Get the schema for an entity class.',
      inputSchema: { type: 'object', properties: { className: { type: 'string' } }, required: ['className'] },
      handler: async (args) => em.queryClassInfo(args.className as string),
    },
    {
      name: 'queryEntities',
      description: 'List entity IDs for a class. Use getEntity(id) to fetch full records.',
      inputSchema: { type: 'object', properties: { className: { type: 'string' } }, required: ['className'] },
      handler: async (args) => Array.from(em.queryEntities(args.className as string)),
    },
    {
      name: 'getEntity',
      description: 'Get the full record for an entity by ID.',
      inputSchema: { type: 'object', properties: { entityId: { type: 'string' } }, required: ['entityId'] },
      handler: async (args) => em.getEntity(args.entityId as string),
    },
    {
      name: 'getEntityField',
      description: 'Get a specific field value with its version. Use jsonPath like "$.fieldName".',
      inputSchema: { type: 'object', properties: { entityId: { type: 'string' }, jsonPath: { type: 'string' } }, required: ['entityId', 'jsonPath'] },
      handler: async (args) => em.getEntityField(args.entityId as string, args.jsonPath as string),
    },
    {
      name: 'queryIntents',
      description: 'List shared intents with namespace and tags. Pass tag conditions to filter (AND across conditions, IN within each). Returns { name, desc, namespace, tags }[]. Always pass conditions when possible — unfiltered results can be large.',
      inputSchema: {
        type: 'object',
        properties: {
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                values: { type: 'array', items: { type: 'string' } },
              },
              required: ['tag', 'values'],
            },
          },
        },
      },
      handler: async (args) => {
        if (!intentsDir) return [];
        const all = scanIntentsDir(intentsDir);
        const conditions = (args.conditions as { tag: string; values: string[] }[] | undefined) ?? [];
        if (conditions.length === 0) return all;
        return all.filter(item =>
          conditions.every(({ tag, values }) => values.includes(item.tags[tag] ?? '')),
        );
      },
    },
    {
      name: 'queryIntentInfo',
      description: 'Get the signature (inputs/outputs) for an intent by name. Use dot-notation for namespaced intents: e.g. "docs.generateDocs".',
      inputSchema: { type: 'object', properties: { intentName: { type: 'string' } }, required: ['intentName'] },
      handler: async (args) => {
        if (!intentsDir) return { error: 'intentsDir not configured' };
        return getIntentInfoFromDir(args.intentName as string, intentsDir);
      },
    },
    {
      name: 'getTagDefinitions',
      description: 'Get all tag dimension definitions. Call this first to understand the tag schema before constructing queryClassesByTags or queryEntitiesByTags conditions.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => Array.from(em.getTagDefinitions()),
    },
    {
      name: 'queryClassesByTags',
      description: 'Filter classes by class-level tag conditions (AND across conditions, IN within each). Returns matching classes with their name, desc, and all class tags. Use with empty conditions to list all classes.',
      inputSchema: {
        type: 'object',
        properties: {
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                values: { type: 'array', items: { type: 'string' } },
              },
              required: ['tag', 'values'],
            },
          },
        },
        required: ['conditions'],
      },
      handler: async (args) => Array.from(em.queryClassesByTags(args.conditions as unknown as import('../entity-store').TagCondition[])),
    },
    {
      name: 'queryEntitiesByTags',
      description: 'Filter entities of one class by entity-level tag conditions (AND across conditions, IN within each). Returns matching entity IDs. Use getEntity on each ID to fetch full data.',
      inputSchema: {
        type: 'object',
        properties: {
          className: { type: 'string' },
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                values: { type: 'array', items: { type: 'string' } },
              },
              required: ['tag', 'values'],
            },
          },
        },
        required: ['className', 'conditions'],
      },
      handler: async (args) => Array.from(em.queryEntitiesByTags(
        args.className as string,
        args.conditions as unknown as import('../entity-store').TagCondition[],
      )),
    },
    {
      name: 'queryIntentsByTags',
      description: 'Filter intents by tag conditions (AND across conditions, IN within each). Returns matching intents with name, desc, and tags. Use with empty conditions [] to list all tagged intents.',
      inputSchema: {
        type: 'object',
        properties: {
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                values: { type: 'array', items: { type: 'string' } },
              },
              required: ['tag', 'values'],
            },
          },
        },
        required: ['conditions'],
      },
      handler: async (args) => Array.from(em.queryIntentsByTags(
        args.conditions as unknown as import('../entity-store').TagCondition[],
      )),
    },
  ];
  return tools.map(tool => ({ ...tool, readOnly: true }));
}

export function createPlatformReadHost(em: EntityStore, intentsDir?: string) {
  return createToolHost(createPlatformReadTools(em, intentsDir));
}

/**
 * Scan the flat intents/ layout: intents/<ns_dirs>/<intentName>/<intentName>.itt.json
 * An intent file is recognised when its parent directory name matches the stem.
 * Namespace = dot-joined path from `dir` to the parent of the intent directory.
 */
function scanIntentsDir(dir: string): { name: string; desc: string; namespace: string; tags: Record<string, string> }[] {
  const byKey = new Map<string, { name: string; desc: string; namespace: string; tags: Record<string, string>; hasLeaf: boolean; public: boolean }>();

  const inside = withinRoot(dir);
  const visited = new Set<string>();
  const scan = (d: string): void => {
    if (!inside(d)) return;
    const actual = fs.realpathSync(d);
    if (visited.has(actual)) return;
    visited.add(actual);
    let entries: string[];
    try { entries = fs.readdirSync(d).sort(); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(d, entry);
      if (!inside(fullPath)) continue;
      let stat: ReturnType<typeof fs.statSync>;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (stat.isDirectory()) { if (!fs.lstatSync(fullPath).isSymbolicLink()) scan(fullPath); continue; }

      let name: string; let hasImpl: boolean;
      if (entry.endsWith('.itt.impl.json')) { name = entry.slice(0, -'.itt.impl.json'.length); hasImpl = true; }
      else if (entry.endsWith('.itt.json')) { name = entry.slice(0, -'.itt.json'.length); hasImpl = false; }
      else continue;

      // Flat layout: the parent dir must be the intent's own named directory
      if (path.basename(d) !== name) continue;

      // Namespace = path from dir to the grandparent of this file (parent of the intent dir)
      const intentDir = d;
      const nsDir = path.dirname(intentDir);
      const relNs = path.relative(dir, nsDir);
      const namespace = relNs === '.' ? '' : relNs.split(path.sep).join('.');

      const key = namespace ? `${namespace}.${name}` : name;
      if (byKey.get(key)?.hasLeaf) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as { desc?: string; description?: string; tags?: Record<string, string>; public?: boolean };
        byKey.set(key, { name, desc: parsed.desc ?? parsed.description ?? '', namespace, tags: parsed.tags ?? {}, hasLeaf: !hasImpl, public: parsed.public !== false });
      } catch { /* skip unreadable */ }
    }
  };

  scan(dir);
  return Array.from(byKey.values()).filter(item => item.public).map(({ name, desc, namespace, tags }) => ({ name, desc, namespace, tags }));
}

function findIntentFile(name: string, dir: string, inside: (candidate: string) => boolean, visited = new Set<string>()): string | null {
  if (!inside(dir)) return null;
  const actual = fs.realpathSync(dir);
  if (visited.has(actual)) return null;
  visited.add(actual);
  let entries: string[];
  try { entries = fs.readdirSync(dir).sort(); } catch { return null; }
  for (const filename of [`${name}.itt.json`, `${name}.itt.impl.json`]) {
    const file = path.join(dir, filename);
    if (inside(file) && fs.statSync(file).isFile()) return file;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    if (!inside(fullPath)) continue;
    let stat: ReturnType<typeof fs.statSync>;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) {
      if (fs.lstatSync(fullPath).isSymbolicLink()) continue;
      const found = findIntentFile(name, fullPath, inside, visited);
      if (found) return found;
      continue;
    }
  }
  return null;
}

function getIntentInfoFromDir(intentName: string, dir: string): unknown {
  if (!intentName || intentName.split('.').some(part => !part || /[\\/\0]/.test(part))) {
    return { error: `Invalid intent name: ${intentName}` };
  }
  let searchDir = dir;
  let leafName: string;
  const dotIdx = intentName.lastIndexOf('.');
  if (dotIdx !== -1) {
    const nsParts = intentName.slice(0, dotIdx).split('.');
    leafName = path.basename(intentName.slice(dotIdx + 1));
    searchDir = path.join(dir, ...nsParts);
  } else {
    leafName = path.basename(intentName);
  }
  const inside = withinRoot(dir);
  // Qualified identities must not silently resolve another module's same-named export.
  const filePath = dotIdx === -1 ? findIntentFile(leafName, searchDir, inside)
    : [`${leafName}.itt.json`, `${leafName}.itt.impl.json`].map(file => path.join(searchDir, leafName, file)).find(file => inside(file) && fs.statSync(file).isFile());
  if (!filePath) return { error: `Intent not found: ${intentName}` };
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
    desc?: string; description?: string; inputs?: Record<string, unknown>; outputs?: Record<string, unknown>;
  };
  return { name: leafName, desc: parsed.desc ?? parsed.description ?? '', inputs: parsed.inputs ?? {}, outputs: parsed.outputs ?? {} };
}

/** Resolve symlinks before reading; a catalogue cannot expose files outside its root. */
function withinRoot(root: string): (candidate: string) => boolean {
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return () => false; }
  return candidate => {
    try {
      const relative = path.relative(realRoot, fs.realpathSync(candidate));
      return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    } catch { return false; }
  };
}
