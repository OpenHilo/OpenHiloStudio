/** The composition root owns shutdown ordering; HTTP waits for connections between these phases. */
export function createDeploymentLifecycle(resources: {
  scheduler: { stop(): void; drain(): Promise<void> };
  workers: { stopAccepting(): void; close(): Promise<void> };
  generation: { close(): Promise<void> };
  ipc?: { stop(): Promise<void> };
  store: { close(): void };
}) {
  let quiescing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const quiesce = (): Promise<void> => {
    if (quiescing) return quiescing;
    // Admission closes before yielding to any queued timer or request.
    resources.scheduler.stop();
    resources.workers.stopAccepting();
    return quiescing = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => resources.generation.close()),
        Promise.resolve().then(() => resources.workers.close()),
        Promise.resolve().then(() => resources.scheduler.drain()),
      ]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Deployment shutdown did not drain all work');
    })();
  };
  const close = (): Promise<void> => closing ??= (async () => {
    await quiesce();
    await resources.ipc?.stop();
    resources.store.close();
  })();
  return { quiesce, close };
}
