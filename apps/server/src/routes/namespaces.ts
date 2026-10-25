import type { StudioApplication } from '@openhilo/studio-contracts';
import * as fs from 'fs';
import * as path from 'path';
import type { FastifyInstance } from 'fastify';
import type { ServerPaths } from '../ports';
import { containedFile, workflowSourceFile } from '../files';

const validPart = (value: string) => /^[\p{ID_Continue}$-]+$/u.test(value);
const validNamespace = (value: string) => value.split('.').every(validPart);
function directories(directory: string): string[] {
  try { return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && validPart(entry.name)).map(entry => entry.name).sort(); }
  catch { return []; }
}
function metadata(file: string | undefined): Record<string, unknown> | undefined {
  if (!file) return;
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
  catch { return; }
}
function namespaceDirectory(root: string, namespace: string): string | undefined {
  let directory = root;
  // Do not traverse symlink directories, including internal cycles.
  for (const part of namespace.split('.')) {
    if (!directories(directory).includes(part)) return;
    directory = path.join(directory, part);
  }
  return directory;
}
function readIntents(paths: ServerPaths, namespace: string, directory: string, application?: StudioApplication) {
  return directories(directory).flatMap(name => {
    const prefix = path.relative(paths.intentsDir, path.join(directory, name, name));
    const leafPath = containedFile(paths.intentsDir, prefix + '.itt.json');
    const implPath = containedFile(paths.intentsDir, prefix + '.itt.impl.json');
    const leaf = metadata(leafPath), impl = metadata(implPath);
    if ((!leaf && !impl) || leaf?.public === false || (!leaf && impl?.public === false)) return [];
    const field = application?.workflowFacet?.field;
    const value = field && Object.hasOwn(leaf ?? {}, field) ? leaf?.[field] : field && Object.hasOwn(impl ?? {}, field) ? impl?.[field] : undefined;
    const rawTags = leaf?.tags ?? impl?.tags;
    const tags = rawTags && typeof rawTags === 'object' && !Array.isArray(rawTags) ? Object.fromEntries(Object.entries(rawTags).filter(([,v]) => typeof v === 'string')) : {};
    return [{ name, ...(Object.keys(tags).length ? { tags } : {}), ...(typeof value === 'string' ? { facet: value } : {}), desc: typeof leaf?.desc === 'string' ? leaf.desc : typeof impl?.description === 'string' ? impl.description : '',
      hasTs: !!workflowSourceFile(paths.brainDir, namespace, name, leaf, impl), hasImpl: !!implPath, isEntry: !!leafPath }];
  });
}

export function registerNamespacesRoutes(app: FastifyInstance, paths: ServerPaths, application?: StudioApplication): void {
  app.get('/api/namespaces', async (req, reply) => {
    const { facet } = req.query as { facet?: unknown };
    if (facet !== undefined && typeof facet !== 'string') return reply.code(400).send({ error: 'Invalid workflow group' });
    const result: Array<{ namespace: string; entries: string[]; intents: string[] }> = [];
    const visit = (directory: string, parts: string[]): void => {
      if (parts.length) {
        const namespace = parts.join('.'), intents = readIntents(paths, namespace, directory, application)
          .filter(intent => !application?.workflowFacet || !facet || intent.facet === facet);
        if (intents.length) result.push({ namespace, entries: intents.filter(i => i.isEntry).map(i => i.name), intents: intents.map(i => i.name) });
      }
      for (const name of directories(directory)) visit(path.join(directory, name), [...parts, name]);
    };
    visit(paths.intentsDir, []);
    return result;
  });

  app.get('/api/namespaces/:ns', async (req, reply) => {
    const { ns } = req.params as { ns: string };
    if (!validNamespace(ns)) return reply.code(400).send({ error: 'Invalid namespace name' });
    const directory = namespaceDirectory(paths.intentsDir, ns);
    if (!directory) return reply.code(404).send({ error: `Namespace '${ns}' not found` });
    const intents = readIntents(paths, ns, directory, application);
    return { namespace: ns, entries: intents.filter(i => i.isEntry).map(i => i.name), intents };
  });

  app.get('/api/namespaces/:ns/:intent/itt', async (req, reply) => {
    const { ns, intent } = req.params as { ns: string; intent: string };
    if (!validNamespace(ns) || !validPart(intent)) return reply.code(400).send({ error: 'Invalid namespace or intent name' });
    const directory = namespaceDirectory(paths.intentsDir, ns);
    if (!directory || !directories(directory).includes(intent)) return reply.code(404).send({ error: 'Intent not found' });
    const prefix = path.relative(paths.intentsDir, path.join(directory, intent, intent));
    const leafPath = containedFile(paths.intentsDir, prefix + '.itt.json');
    const implPath = containedFile(paths.intentsDir, prefix + '.itt.impl.json');
    if (!leafPath) return reply.code(404).send({ error: 'Intent not found' });
    try {
      const leaf = JSON.parse(fs.readFileSync(leafPath, 'utf8'));
      const impl = implPath ? JSON.parse(fs.readFileSync(implPath, 'utf8')) : null;
      const source = workflowSourceFile(paths.brainDir, ns, intent, leaf, impl);
      return { leaf, impl, ts: source ? fs.readFileSync(source, 'utf8') : null };
    } catch { return reply.code(500).send({ error: 'Failed to read Workflow files' }); }
  });

  // The obsolete bucket never affects the filesystem path.
  app.get('/api/namespaces/:bucket/:ns', async (req, reply) => {
    const { ns } = req.params as { bucket: string; ns: string };
    return reply.redirect(`/api/namespaces/${encodeURIComponent(ns)}`);
  });
  app.get('/api/namespaces/:bucket/:ns/:intent/itt', async (req, reply) => {
    const { ns, intent } = req.params as { bucket: string; ns: string; intent: string };
    return reply.redirect(`/api/namespaces/${encodeURIComponent(ns)}/${encodeURIComponent(intent)}/itt`);
  });
}
