import { randomUUID } from 'crypto';
import { AbortError, FailableError } from '@openhilo/runtime-contracts';
import type { SysCallFn } from './system-executor';
import type { WorkerMessage } from './worker-protocol';

/** Child-side system calls have one delivery attempt and explicit listener ownership. */
export function createWorkerSystemClient(channel: NodeJS.Process = process, timeoutMs = 30_000): { call: SysCallFn; close(): void } {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('System call timeout must be positive');
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let closed = false;
  const unknown = () => new AbortError('System call delivery outcome is unknown; inspect persisted state before retrying');
  function settle(id: string, error?: Error, value?: unknown) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer);
    error ? entry.reject(error) : entry.resolve(value);
  }
  function onMessage(message: WorkerMessage) {
    if (!message || message.type !== 'sys_response') return;
    settle(message.reqId, message.error ? new FailableError(message.error) : undefined, message.result);
  }
  function close() {
    closed = true;
    for (const id of pending.keys()) settle(id, unknown());
    channel.off('message', onMessage); channel.off('disconnect', close);
  }
  channel.on('message', onMessage); channel.once('disconnect', close);
  return {
    call(method, args) {
      if (closed || !channel.send || channel.connected === false) return Promise.reject(new AbortError('System call channel is disconnected'));
      return new Promise((resolve, reject) => {
        const reqId = randomUUID();
        const timer = setTimeout(() => settle(reqId, unknown()), timeoutMs);
        pending.set(reqId, { resolve, reject, timer });
        try { channel.send!({ type: 'sys_call', reqId, method, args } satisfies WorkerMessage, error => { if (error) settle(reqId, unknown()); }); }
        catch { settle(reqId, unknown()); }
      });
    }, close,
  };
}
