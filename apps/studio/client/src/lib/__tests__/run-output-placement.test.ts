import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunEventStream } from '../../components/RunEventStream';

// Syntax highlighting is unrelated to activity ownership and loads ESM-only assets.
jest.mock('../../components/CodeViewer', () => ({ CodeViewer: ({ code }: { code: string }) => code }));

const health = { phase: 'model', condition: 'active', elapsedMs: 1000, idleMs: 0,
  phaseElapsedMs: 1000, activeTools: 0, observedAt: new Date().toISOString(), heartbeatMs: 5000 };
const start = (id: string) => ({ event: 'node_pending', node_run_id: id, node_id: 'write_game', node_type: 'call', executor: 'ai' });
const progress = (id: string, message: string) => ({ event: 'ai_progress', node_run_id: id, message });
const heartbeat = (id: string) => ({ event: 'ai_health', node_run_id: id, health });
const render = (events: unknown[], status = 'running') => renderToStaticMarkup(createElement(RunEventStream, { runId: 'fixture', authoritativeEvents: events, runStatus: status }));
const rows = (html: string) => [...html.matchAll(/<li class="activity-row">([\s\S]*?)<\/li>/g)].map(match => match[1]);

test('live output and health belong to the current invocation, with earlier loop output kept separate', () => {
  const html = render([start('first'), heartbeat('first'), progress('first', 'FIRST_OUTPUT'),
    { event: 'node_success', node_run_id: 'first', outputs: {} },
    start('second'), heartbeat('second'), progress('second', 'SECOND_OUTPUT'), progress('unrelated', 'UNRELATED_OUTPUT')]);
  const cards = rows(html);
  expect(cards).toHaveLength(2);
  expect(cards[0]).toContain('FIRST_OUTPUT');
  expect(cards[0]).not.toContain('SECOND_OUTPUT');
  expect(cards[0]).not.toContain('· Live');
  expect(cards[1]).toContain('SECOND_OUTPUT');
  expect(cards[1]).not.toContain('FIRST_OUTPUT');
  expect(cards[1]).toContain('· Live');
  expect(cards[1]).toContain('Waiting for model');
  expect(html.slice(0, html.indexOf('<ol'))).not.toContain('AI output');
  expect(cards.join('')).not.toContain('UNRELATED_OUTPUT');
  // Live output is visible even when the node's input/result details are closed.
  expect(cards[1].indexOf('class="ai-output')).toBeGreaterThan(cards[1].indexOf('</details>'));
  expect((cards[1].match(/SECOND_OUTPUT/g) ?? [])).toHaveLength(1);
});

test('simultaneous AI calls have independent live output panels', () => {
  const cards = rows(render([start('a'), start('b'), heartbeat('a'), heartbeat('b'), progress('a', 'ONLY_A'), progress('b', 'ONLY_B')]));
  expect(cards[0]).toContain('ONLY_A'); expect(cards[0]).not.toContain('ONLY_B');
  expect(cards[1]).toContain('ONLY_B'); expect(cards[1]).not.toContain('ONLY_A');
  for (const card of cards) expect(card).toContain('· Live');
});

test('output appears before the first heartbeat and loses Live when the run ends', () => {
  const events = [start('a'), progress('a', 'EARLY_OUTPUT')];
  expect(rows(render(events))[0]).toContain('· Live');
  const complete = rows(render(events, 'completed'))[0];
  expect(complete).toContain('EARLY_OUTPUT');
  expect(complete).not.toContain('· Live');
  expect(complete).not.toContain('Waiting for model');
});
