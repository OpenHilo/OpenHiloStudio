import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HumanTasksBlock } from '../../components/HumanTasksBlock';
import type { HumanHistoryItem } from '../../api/human';

const item: HumanHistoryItem = {
  nodeRunId: 'human-starting', nodeId: 'call_confirm', prompt: 'Continue?',
  resolvedInputs: {}, outputTypes: [], startedAt: '2026-10-11T12:00:00Z', status: 'incomplete',
};

function render(runStatus: string) {
  return renderToStaticMarkup(createElement(HumanTasksBlock, { runId: 'run-test', history: [item], runStatus }));
}

test('a running human node is preparing, not presented as a failed historical task', () => {
  const html = render('running');
  expect(html).toContain('preparing');
  expect(html).not.toContain('incomplete');
  expect(html).not.toContain('bg-red-100');
});

test.each(['failed', 'aborted', 'completed', 'unknown'])('an incomplete node stays incomplete when the run is %s', status => {
  expect(render(status)).toContain('incomplete');
  expect(render(status)).not.toContain('preparing');
});
