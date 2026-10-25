import type { HumanExecutor, HumanTaskHost, HumanTaskRequest } from '@openhilo/human-contracts';
export interface StudioHumanExecutorOptions {
  notify?: (task: HumanTaskRequest) => void | Promise<void>;
}
export class StudioHumanExecutor implements HumanExecutor {
  readonly id = 'studio';
  constructor(private readonly options: StudioHumanExecutorOptions = {}) {}
  /** Runtime owns the durable pending task and accepts submissions independently. */
  async present(request: HumanTaskRequest, host: HumanTaskHost): Promise<void> {
    if (host.signal.aborted) return;
    await this.options.notify?.(request);
  }
}
