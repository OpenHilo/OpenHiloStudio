import * as path from 'path';
import type { AiExecution, TaskRequest, ToolHost } from '@openhilo/ai-contracts';
import { createAiQuestionService } from './ai-questions';
import { createWorkerQuestionServer } from './worker-questions';

/** Worker-owned tools and questions; no provider or credentials are constructed here. */
export function createWorkerAiHost(options: { createTools?(): { tools: ToolHost; close?(): void | Promise<void> } } = {}) {
  let resources: ReturnType<NonNullable<typeof options.createTools>> | undefined;
  let tools: ToolHost | undefined;
  let questions: ReturnType<typeof createAiQuestionService> | undefined;
  let server: ReturnType<typeof createWorkerQuestionServer> | undefined;
  const hosted = new Set<string>();
  return {
    start(runDir: string) {
      if (questions) throw new Error('Worker AI host is already started');
      questions = createAiQuestionService({ filePath: path.join(runDir, 'ai-questions.json') });
      server = createWorkerQuestionServer((key, value) => questions!.answer(key, value), { onDisconnect: () => questions!.close() });
    },
    host: (request: TaskRequest) => {
      if (!questions) throw new Error('Worker AI host has not started');
      if (!resources && options.createTools) { resources = options.createTools(); tools = resources.tools; }
      const host = questions.host(request);
      hosted.add(request.taskId);
      return { ...host, tools };
    },
    attach: (execution: AiExecution, request: TaskRequest) => {
      // The legacy native composition does not request this host (and does not advertise questions).
      if (hosted.delete(request.taskId)) questions!.attach(execution, request);
    },
    async drain() { await questions?.drain(); await server?.drain(); },
    async close() {
      try { await questions?.close(); await server?.drain(); }
      finally { server?.close(); const owned = resources; resources = undefined; tools = undefined; await owned?.close?.(); }
    },
  };
}
