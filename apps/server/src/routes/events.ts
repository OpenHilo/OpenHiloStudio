import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { findRunDir } from '@openhilo/platform-services/run-history';
import type { BroadcasterPort } from '../ports';
import type { WorkerPort as WorkerManager } from '../ports';
import type { ServerPaths } from '../ports';

export function registerEventRoutes(app: FastifyInstance, broadcaster: BroadcasterPort, workerManager: WorkerManager, paths: ServerPaths): void {
  const runsDir = paths.runsDir;

  app.get('/api/runs/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runDir = await findRunDir(id, runsDir);
    if (!runDir) return reply.code(404).send({ error: 'Run not found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // The worker persists before its ordered IPC forwarding completes. A new
    // subscriber can therefore see an event in both disk replay and live IPC.
    const replayed = new Map<string, number>();
    const jsonlPath = path.join(runDir, 'execution.jsonl');
    if (fs.existsSync(jsonlPath)) {
      const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim());
      for (const l of lines) {
        try {
          const event = JSON.parse(l);
          const key = JSON.stringify(event);
          replayed.set(key, (replayed.get(key) ?? 0) + 1);
          reply.raw.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
        } catch {}
      }
    }

    if (workerManager.isActive(id)) {
      const clientId = Math.random().toString(36).substring(2);
      broadcaster.subscribe(id, {
        id: clientId,
        write: (data) => {
          try {
            const message = JSON.parse(data.replace(/^data: /, '').trim());
            if (message.type === 'event') {
              const key = JSON.stringify(message.event);
              const count = replayed.get(key) ?? 0;
              if (count > 0) { replayed.set(key, count - 1); return; }
              // IPC is ordered: once a new event arrives, the replay overlap is over.
              replayed.clear();
            }
          } catch { /* Other frames retain their existing wire representation. */ }
          reply.raw.write(data);
        },
        close: () => reply.raw.end(),
      });
      req.raw.on('close', () => broadcaster.unsubscribe(id, clientId));
    } else {
      reply.raw.end();
    }
  });
}
