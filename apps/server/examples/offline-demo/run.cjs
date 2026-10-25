const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { initializeDemo, openDemo } = require('./host.cjs');

async function walkthrough(home, log = () => {}) {
  initializeDemo(home);
  let host = await openDemo(home);
  const request = async (method, url, payload, status = 200) => {
    const response = await host.app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
    return response.json();
  };
  const wait = async (read) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Demo operation did not settle in time');
  };
  try {
    assert.deepEqual(await request('GET', '/api/tag-definitions'), []);
    await request(
      'POST',
      '/api/classes',
      { name: 'Document', desc: 'Offline report', schema: {}, tags: {} },
      201
    );
    const created = await request('POST', '/api/translate/start', {
      naturalLanguage: 'Create a report with human approval',
    });
    assert.equal(created.step.phase, 'cc_running');
    const sessionId = created.sessionId;
    const clarification = await wait(async () => {
      const step = await request('GET', `/api/translate/${sessionId}`);
      return step.phase !== 'cc_running' && step;
    });
    assert.equal(clarification.phase, 'cc_waiting_for_answer');
    const repaired = await request('POST', `/api/translate/${sessionId}/respond`, {
      type: 'mcp_answer',
      questionId: 'format',
      answer: 'Plain text',
    });
    assert.equal(repaired.phase, 'confirm_merge', JSON.stringify(repaired));
    assert.equal(host.executor.generations, 2);
    assert.equal(fs.existsSync(path.join(home, 'brain', 'demo', 'report.ts')), false);
    assert.deepEqual(fs.readdirSync(path.join(home, 'intents')), []);
    log(
      'Clarified requirements; real TypeScript compilation rejected the first candidate and accepted the repair.'
    );
    // Reopen with the same persisted deployment identity while preserving approval and its worktree lease.
    await host.app.close();
    host = await openDemo(home);
    assert.equal((await request('GET', `/api/translate/${sessionId}`)).phase, 'confirm_merge');
    const refreshed = await request('POST', `/api/translate/${sessionId}/respond`, { type: 'merge_approve', reviewId: repaired.reviewId });
    assert.equal(refreshed.phase, 'confirm_merge');
    assert.notEqual(refreshed.reviewId, repaired.reviewId);
    assert.deepEqual(refreshed.preflight.contents, repaired.preflight.contents);
    log('The restarted host recompiled the candidate. Review its unchanged source before approving the new receipt.');
    const approved = await request('POST', `/api/translate/${sessionId}/respond`, { type: 'merge_approve', reviewId: refreshed.reviewId });
    assert.equal(approved.phase, 'done', JSON.stringify(approved));
    assert.equal(host.executor.generations, 0, 'approval must not invoke AI again');
    log('Restarted at review and published the approved source and compiled workflow artifacts.');
    const workdir = path.join(home, 'workspaces', 'report');
    const { runId } = await request(
      'POST',
      '/api/runs',
      { ittPath: 'demo/report/report.itt.impl.json', workdir, inputs: {} },
      201
    );
    const question = await wait(async () => {
      const questions = await request('GET', `/api/runs/${runId}/ai-questions`);
      return questions.find((item) => item.available);
    });
    const key = { taskId: question.taskId, attemptId: question.attemptId, questionId: question.questionId };
    await request('POST', `/api/runs/${runId}/ai-questions/answer`, { key, value: 'Concise' });
    await wait(async () => !host.workers.isActive(runId));
    const human = await request('GET', `/api/runs/${runId}/human-node`);
    assert.deepEqual(human.outputs, [{ name: 'approved', kind: 'boolean' }]);
    await request(
      'POST',
      `/api/runs/${runId}/resume`,
      { humanNodeRunId: human.nodeRunId, humanOutput: { approved: 'invalid' } },
      400
    );
    assert.equal((await request('GET', `/api/runs/${runId}`)).status, 'suspended');
    await request('POST', `/api/runs/${runId}/resume`, {
      humanNodeRunId: human.nodeRunId,
      humanOutput: { approved: 'true' },
    });
    await wait(async () => !host.workers.isActive(runId));
    const run = await request('GET', `/api/runs/${runId}`);
    assert.equal(run.status, 'completed');
    for (const executor of ['sys', 'ai', 'code'])
      assert.equal(
        run.events.filter((event) => event.event === 'node_pending' && event.executor === executor).length,
        1,
        `${executor} must execute once across resume`
      );
    const output = fs.readFileSync(path.join(workdir, 'report.txt'), 'utf8');
    assert.equal(output, 'Concise: OpenHilo modular architecture\n');
    assert.equal(
      fs.readFileSync(path.join(workdir, 'ai-effects.jsonl'), 'utf8').trim().split('\n').length,
      1
    );
    const history = await request('GET', `/api/runs/${runId}/human-history`);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'completed');
    assert.deepEqual(history[0].result, { approved: true });
    const entities = await request('GET', '/api/entities?className=Document');
    assert.equal(entities.length, 1);
    assert.equal(entities[0].name, 'demo-report');
    log(
      'Ran published workflow: SQLite system write → AI question → human suspension → fresh worker resume → Bash report.'
    );
    // Exercise a real persisted schedule and supervisor launch with the explicitly injected clock.
    const schedule = await request(
      'POST',
      '/api/schedules',
      {
        name: 'Offline tick',
        cron: '* * * * *',
        ittPath: 'demo/report/report.itt.impl.json',
        workdir: path.join(home, 'workspaces', 'scheduled'),
        inputs: {},
      },
      201
    );
    host.tick();
    await host.drainSchedules();
    const scheduled = (await request('GET', '/api/schedules')).find((item) => item.id === schedule.id);
    assert.ok(scheduled.lastRunId);
    await wait(async () =>
      (await request('GET', `/api/runs/${scheduled.lastRunId}/ai-questions`)).some((item) => item.available)
    );
    const scheduledRun = await request('GET', `/api/runs/${scheduled.lastRunId}`);
    assert.equal(scheduledRun.triggeredBy, 'schedule');
    await host.app.close();
    assert.equal(host.workers.activeRunIds().size, 0);
    host = await openDemo(home);
    // Graceful shutdown confirms AI cancellation; it is terminal, not a retryable failure.
    const stopped = await request('GET', `/api/runs/${scheduled.lastRunId}`);
    assert.equal(stopped.status, 'aborted');
    assert.equal(stopped.events.at(-1).event, 'run_abort');
    assert.equal(stopped.events.some((event) => event.event === 'run_failed'), false);
    const refused = await host.app.inject({ method: 'POST', url: `/api/runs/${scheduled.lastRunId}/resume`, payload: {} });
    assert.ok(refused.statusCode >= 400);
    assert.equal(host.workers.isActive(scheduled.lastRunId), false);
    const closedQuestions = await request('GET', `/api/runs/${scheduled.lastRunId}/ai-questions`);
    assert.equal(closedQuestions.length, 1);
    assert.equal(closedQuestions[0].status, 'closed');
    assert.equal(closedQuestions[0].available, false);
    assert.equal(fs.existsSync(path.join(home, 'workspaces', 'scheduled', 'report.txt')), false);
    log('Triggered the injected schedule clock and closed the host while the second AI task was waiting.');
    const result = {
      home,
      sessionId,
      runId,
      scheduledRunId: scheduled.lastRunId,
      output: output.trim(),
      aiRequests: 'scripted only',
    };
    fs.writeFileSync(path.join(home, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    await host.app.close();
  }
}
module.exports = { walkthrough };
if (require.main === module) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intentorch-offline-demo-'));
  console.log(`Demo data: ${home}`);
  walkthrough(home, console.log)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
