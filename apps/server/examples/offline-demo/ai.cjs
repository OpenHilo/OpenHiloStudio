// Deliberately scripted executor: demonstrates the contract, never calls a model.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createTaskExecution } = require('@openhilo/ai-contracts');
const identity = 'intentorch.offline-demo.v1';
const source = `
declare function summarize_by_ai(role: string, prompt: string, content: string): Promise<{ summary: string }>;
declare function approve_by_human(prompt: string, summary: string): Promise<{ approved: boolean }>;
declare function write_by_code(lang: 'bash', script: string, inputs: { content: string }): Promise<{}>;
/** @entry */
export async function report(): Promise<{ approved: boolean; revision: number }> {
  const revision: number = 1;
  await createEntity_by_sys('Document', 'demo-report', {}, 'Generated demo report', {});
  const { summary } = await summarize_by_ai('writer', 'Prepare a short report', 'OpenHilo modular architecture');
  const { approved } = await approve_by_human('Approve this report?', summary);
  if (approved) {
    await write_by_code('bash', ${JSON.stringify('printf \'%s\\n\' "$content" >> report.txt')}, { content: summary });
  }
  return { approved, revision };
}
`;
function createOfflineExecutor() {
  let generations = 0;
  return {
    id: identity,
    capabilities: ['workspace', 'questions', 'structured_output'],
    get generations() {
      return generations;
    },
    async start(request, host) {
      return createTaskExecution(request, host, async (execution) => {
        const workspace = fileURLToPath(host.workspace.uri);
        if (request.output.entries) {
          const attempt = ++generations;
          if (attempt === 1)
            await execution.ask({ id: 'format', prompt: 'Which report format?', answer: 'text' });
          else if (!/not assignable|compile failed/i.test(request.instruction))
            throw new Error('Expected compiler feedback before repair');
          fs.mkdirSync(path.join(workspace, 'demo'), { recursive: true });
          fs.writeFileSync(
            path.join(workspace, 'demo', 'report.ts'),
            attempt === 1 ? source.replace('number = 1', 'number = "invalid"') : source
          );
          return { status: 'completed', outputs: { entries: ['demo/report'] }, artifacts: [] };
        }
        const style = await execution.ask({ id: 'style', prompt: 'Report style?', answer: 'text' });
        const summary = `${style}: ${request.inputs.content}`;
        fs.appendFileSync(path.join(workspace, 'ai-effects.jsonl'), JSON.stringify({ summary }) + '\n');
        return { status: 'completed', outputs: { summary }, artifacts: [] };
      });
    },
  };
}
module.exports = { createOfflineExecutor, identity };
