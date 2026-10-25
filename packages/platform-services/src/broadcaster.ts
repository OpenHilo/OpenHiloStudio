export interface SSEClient { id: string; write(data: string): void; close(): void }

export class Broadcaster {
  private _clients: Map<string, Map<string, SSEClient>> = new Map();

  subscribe(runId: string, client: SSEClient): void {
    if (!this._clients.has(runId)) this._clients.set(runId, new Map());
    this._clients.get(runId)!.set(client.id, client);
  }

  unsubscribe(runId: string, clientId: string): void {
    this._clients.get(runId)?.delete(clientId);
  }

  publish(runId: string, data: string): void {
    const clients = this._clients.get(runId);
    if (!clients) return;
    for (const client of clients.values()) {
      try { client.write(data); } catch { /* ignore disconnected */ }
    }
  }

  closeAll(runId: string): void {
    const clients = this._clients.get(runId);
    if (!clients) return;
    for (const client of clients.values()) {
      try { client.close(); } catch { /* ignore */ }
    }
    this._clients.delete(runId);
  }

  close(): void { for (const runId of [...this._clients.keys()]) this.closeAll(runId); }

  hasSubscribers(runId: string): boolean {
    return (this._clients.get(runId)?.size ?? 0) > 0;
  }
}
