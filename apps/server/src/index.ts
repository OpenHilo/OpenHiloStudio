import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import * as fs from 'fs';
import * as path from 'path';
import { isIP } from 'node:net';
import type { StudioApplication } from '@openhilo/studio-contracts';
import type { ServerPaths, WorkerPort, ConfigurationPort, GenerationPort, EntityPort, FilterPort, SchedulePort, SchedulerPort, BroadcasterPort } from './ports';
import { registerRunRoutes } from './routes/runs';
import { registerEventRoutes } from './routes/events';
import { registerStatsRoutes } from './routes/stats';
import { registerHumanRoutes } from './routes/human';
import { registerFilterRoutes } from './routes/filters';
import { registerScheduleRoutes } from './routes/schedules';
import { registerTranslateRoutes } from './routes/translate';
import { registerEntityRoutes } from './routes/entity';
import { registerConfigRoutes } from './routes/config';
import { registerNamespacesRoutes } from './routes/namespaces';
import { registerApplicationRoutes } from './routes/application';
export type { ServerPaths, WorkerPort, ConfigurationPort, GenerationPort, EntityPort, FilterPort, SchedulePort, SchedulerPort, BroadcasterPort } from './ports';

export interface ServerOptions {
  paths: ServerPaths;
  workers: WorkerPort;
  broadcaster: BroadcasterPort;
  entities: EntityPort;
  filters: FilterPort;
  schedules: SchedulePort;
  scheduler: SchedulerPort;
  configuration: ConfigurationPort;
  generation: GenerationPort;
  application?: StudioApplication;
  capabilities?: readonly string[];
  publicDir?: string;
  logger?: FastifyServerOptions['logger'];
  corsOrigin?: boolean | string | string[];
  /** Additional trusted DNS hostnames (without scheme/port). IP literals and localhost are always accepted. */
  allowedHosts?: readonly string[];
  /** Optional application/provider endpoints. Generic routes never select their implementation. */
  registerExtensions?(app: FastifyInstance): void | Promise<void>;
  /** Explicitly supplied lifecycle cleanup; the caller owns injected workers/stores/timers. */
  close?(): void | Promise<void>;
}

/** Construct a ready HTTP application. Importing or constructing does not listen, discover accounts or choose a provider. */
export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  for (const key of ['runsDir', 'intentsDir', 'brainDir', 'workspacesDir'] as const) {
    if (!path.isAbsolute(options.paths[key])) throw new Error(`Server ${key} must be an explicit absolute path`);
  }
  if (options.publicDir && (!path.isAbsolute(options.publicDir) || !fs.existsSync(path.join(options.publicDir, 'index.html')))) {
    throw new Error('Server publicDir must contain a built Studio index.html');
  }
  const allowedHosts = new Set((options.allowedHosts ?? []).map(host => {
    if (typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host)) throw new Error('allowedHosts must contain explicit DNS hostnames without a scheme or port');
    return host.toLowerCase().replace(/\.$/, '');
  }));
  // The injected lifecycle owns drain completion. Avvio's plugin deadline also
  // covers close hooks and must not cut off already-started workflow effects.
  const app = Fastify({
    logger: options.logger ?? false,
    pluginTimeout: 0,
    // Qualified workflow names can exceed the router's 100-character default.
    routerOptions: { maxParamLength: 4096 },
  });
  try {
    // CORS controls response access, not delivery of simple cross-origin POSTs.
    // Reject browser mutations before routing/body parsing; native clients have no Origin.
    app.addHook('onRequest', async (req, reply) => {
      // Host validation also protects same-origin requests after DNS rebinding.
      // Proxy forwarding headers are intentionally not treated as trusted authority.
      let requestOrigin: string;
      try {
        const authority = new URL(`${req.protocol}://${req.headers.host}`);
        if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) throw new Error('Invalid authority');
        const host = authority.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
        if (host !== 'localhost' && !isIP(host) && !allowedHosts.has(host))
          return reply.code(403).send({ error: 'Untrusted Host header. Use localhost, an IP address, or configure an explicit allowedHosts entry.' });
        requestOrigin = authority.origin;
      } catch { return reply.code(400).send({ error: 'Invalid Host header' }); }
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
      const origin = req.headers.origin;
      if (origin === undefined) {
        if (!['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'] as string)) return;
      } else {
        const normalize = (value: string): string | undefined => {
          try {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
                url.pathname !== '/' || url.search || url.hash) return;
            return url.origin;
          } catch { return; }
        };
        const supplied = normalize(origin);
        const sameOrigin = requestOrigin;
        const configured = options.corsOrigin;
        const explicit = configured === true || (typeof configured === 'string' ? [configured] : Array.isArray(configured) ? configured : [])
          .some(value => normalize(value) === supplied);
        if (supplied && (supplied === sameOrigin || explicit)) return;
      }
      return reply.code(403).send({ error: 'Cross-origin browser changes are not allowed. Open Studio directly or configure a trusted CORS origin.' });
    });
    if (options.corsOrigin !== undefined) app.register(cors, { origin: options.corsOrigin });
    if (options.publicDir) app.register(staticFiles, { root: options.publicDir, prefix: '/' });
    registerApplicationRoutes(app, options.application);
    const capabilities = [...(options.capabilities ?? [])];
    app.get('/api/studio-capabilities', async () => ({ version: 1, features: capabilities }));
    registerRunRoutes(app, options.workers, options.paths);
    registerEventRoutes(app, options.broadcaster, options.workers, options.paths);
    registerStatsRoutes(app, options.workers, options.paths);
    registerHumanRoutes(app, options.workers, options.paths);
    registerFilterRoutes(app, options.filters);
    registerScheduleRoutes(app, options.scheduler, options.schedules);
    registerTranslateRoutes(app, options.generation);
    registerEntityRoutes(app, options.entities, options.workers);
    registerConfigRoutes(app, options.configuration);
    registerNamespacesRoutes(app, options.paths, options.application);
    // End persistent streams before Fastify waits for connections to drain.
    app.addHook('preClose', async () => { options.broadcaster.close(); });
    if (options.close) app.addHook('onClose', async () => { await options.close!(); });
    await options.registerExtensions?.(app);
    app.setNotFoundHandler(async (req, reply) => {
      if (options.publicDir && req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.type('text/html').send(fs.readFileSync(path.join(options.publicDir, 'index.html')));
      }
      return reply.code(404).send({ error: 'Not found' });
    });
    await app.ready();
    return app;
  } catch (error) { await app.close().catch(() => {}); throw error; }
}
