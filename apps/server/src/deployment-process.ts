import type { FastifyInstance } from 'fastify';

/** A composition owns resources; this host owns listen/start/signal sequencing. */
export interface ProcessDeployment {
  app: Pick<FastifyInstance, 'listen'>;
  beforeListen?(isStopping: () => boolean): Promise<void>;
  startSchedules(): Promise<void>;
  close(): Promise<void>;
}
export interface DeploymentProcessOptions {
  create(isStopping: () => boolean): Promise<ProcessDeployment | undefined>;
  host: string;
  port: number;
  onListening?(address: string): void | Promise<void>;
  onShutdownError?(error: unknown): void;
  signals?: Pick<NodeJS.Process, 'on' | 'off'>;
}

/** No listeners on import. Shutdown waits for in-flight startup and closes once. */
export async function startDeploymentProcess(options: DeploymentProcessOptions) {
  const signals = options.signals ?? process;
  let deployment: ProcessDeployment | undefined, address: string | undefined;
  let stopping = false, starting: Promise<void> | undefined, closing: Promise<void> | undefined;
  const cleanup = () => { signals.off('SIGINT', onSignal); signals.off('SIGTERM', onSignal); };
  const close = () => closing ??= (async () => {
    stopping = true;
    try { await starting?.catch(() => {}); await deployment?.close(); }
    finally { cleanup(); }
  })();
  const onSignal = () => { void close().catch(error => {
    if (options.onShutdownError) options.onShutdownError(error);
    else { console.error(error instanceof Error ? error.message : 'Shutdown failed'); process.exitCode = 1; }
  }); };
  signals.on('SIGINT', onSignal); signals.on('SIGTERM', onSignal);
  try {
    starting = (async () => {
      deployment = await options.create(() => stopping);
      if (stopping) return;
      if (!deployment) throw new Error('Deployment factory returned no deployment');
      await deployment.beforeListen?.(() => stopping);
      if (stopping) return;
      address = await deployment.app.listen({ host: options.host, port: options.port });
      if (stopping) return;
      await deployment.startSchedules();
      if (!stopping) await options.onListening?.(address);
    })();
    await starting;
    if (stopping) await close();
    return { address, close };
  } catch (error) {
    try { await close(); }
    catch (closeError) { throw new AggregateError([error, closeError], 'Deployment startup and cleanup failed'); }
    throw error;
  }
}
