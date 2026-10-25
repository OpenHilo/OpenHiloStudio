#!/usr/bin/env node
import { isJsonValue } from '@openhilo/ai-contracts';
/** HTTP client for the same question service used by Studio; never starts an AI provider. */
export async function runAiQuestionsCli(argv: string[], io: {
  fetch?: typeof fetch; out?: (text: string) => void; error?: (text: string) => void;
} = {}): Promise<number> {
  const out = io.out ?? console.log, error = io.error ?? console.error;
  try {
    const [command, runId, ...args] = argv;
    if (!['list', 'answer'].includes(command) || !runId || args.length % 2) throw new Error('Usage: intentorch-questions list|answer RUN_ID --server URL [--task ID --attempt ID --question ID --text TEXT|--json JSON]');
    const flags = new Map<string, string>();
    const allowed = command === 'list' ? ['--server'] : ['--server', '--task', '--attempt', '--question', '--text', '--json'];
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.includes(args[i]) || flags.has(args[i])) throw new Error('Unknown or repeated option: ' + args[i]);
      flags.set(args[i], args[i + 1]);
    }
    const base = new URL(flags.get('--server') ?? '');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('--server must be an HTTP(S) origin');
    const url = new URL(`/api/runs/${encodeURIComponent(runId)}/ai-questions${command === 'answer' ? '/answer' : ''}`, base);
    let body: string | undefined;
    if (command === 'answer') {
      const key = { taskId: flags.get('--task'), attemptId: flags.get('--attempt'), questionId: flags.get('--question') };
      if (Object.values(key).some(value => !value?.trim()) || flags.has('--text') === flags.has('--json')) throw new Error('Answer requires --task, --attempt, --question and exactly one of --text or --json');
      const value: unknown = flags.has('--text') ? flags.get('--text') : JSON.parse(flags.get('--json')!);
      if (!isJsonValue(value)) throw new Error('Answer must be a finite JSON value');
      body = JSON.stringify({ key, value });
    }
    const response = await (io.fetch ?? fetch)(url, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }) });
    const result: unknown = await response.json();
    out(JSON.stringify(result, null, 2));
    return response.ok ? 0 : 1;
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    if (argv[0] === 'answer') error('No automatic retry was made. Inspect the saved question status before resubmitting an unconfirmed answer.');
    return 1;
  }
}
if (require.main === module) void runAiQuestionsCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
