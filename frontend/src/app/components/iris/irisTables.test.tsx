import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import fixtures from '../../contracts/iris.v2.fixtures.json';
import type { Answer, Evidence, TurnView } from '../../types/irisV2';
import { IrisAnswer } from './IrisBlocks';

// The live history answer broke "landlord" and its source pills one letter per
// line: a long Event column squeezed the others. Each column now has a floor
// and a narrow panel scrolls the table inside its focusable region instead.

const html = (answer: Answer) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <IrisAnswer answer={answer} historicalLabel={null} onChoose={null} />
    </MemoryRouter>
  );
const F = fixtures as unknown as Record<string, TurnView>;
const at = '2026-10-29T07:23:01.074Z';

const evidence: Evidence = {
  ref: 'ev_cost_step',
  kind: 'audit',
  recordId: 'aud_1',
  requestId: 'req_1',
  routeKind: 'none',
  publicRouteKind: null,
  lastVerifiedAt: at,
  revision: null,
  hash: null,
  occurredAt: at,
  label: 'Cost review step allowed',
};

const timeline = {
  blocks: [
    {
      id: 'blk_timeline',
      sourceType: 'records',
      kind: 'timeline',
      events: [
        {
          at,
          actorLabel: 'landlord',
          title: 'Cost review step allowed',
          text: 'The landlord allowed the stated cost-review step. This decision does not authorize spending or payment.',
          factIds: [],
          evidenceRefs: ['ev_cost_step'],
        },
      ],
    },
  ],
  evidence: [evidence],
  coverage: 'complete',
  source: 'model_planned',
  model: null,
  observedAt: at,
} as unknown as Answer;

const headerClasses = (markup: string, region: string) => {
  const part = markup.slice(markup.indexOf(`data-testid="${region}"`));
  const head = part.match(/<thead>([\s\S]*?)<\/thead>/)![1];
  return [...head.matchAll(/<th scope="col" class="([^"]*)"/g)].map((m) => m[1]);
};

describe('Iris record tables keep words whole', () => {
  it('gives every timeline column a floor, so Who and Source cannot collapse to letters', () => {
    const markup = html(timeline);
    const classes = headerClasses(markup, 'iris-timeline');
    expect(classes).toHaveLength(4);
    for (const c of classes) expect(c).toMatch(/min-w-\[\d+(\.\d+)?rem\]/);
    // The table is at least as wide as its column floors; the region scrolls it.
    expect(markup).toMatch(/<table class="w-full min-w-\[33\.5rem\]/);
    expect(markup).toMatch(/role="region" aria-label="Recorded events" tabindex="0" data-testid="iris-timeline" class="[^"]*overflow-x-auto/);
    expect(markup).toContain('Source: Cost review step allowed');
  });

  it('gives every facts column a floor', () => {
    const markup = html(F.help.answer as Answer);
    const classes = headerClasses(markup, 'iris-facts');
    expect(classes).toHaveLength(3);
    for (const c of classes) expect(c).toMatch(/min-w-\[\d+rem\]/);
  });

  it('puts the cost table in the same named, keyboard-scrollable region and keeps figures on one line', () => {
    const markup = html(F.history.answer as Answer);
    expect(markup).toMatch(/role="region" aria-label="[^"]+" tabindex="0" data-testid="iris-cost-table" class="[^"]*overflow-x-auto/);
    const figures = [...markup.matchAll(/<td class="([^"]*font-mono[^"]*)"/g)].map((m) => m[1]);
    expect(figures.length).toBeGreaterThan(0);
    for (const c of figures) expect(c).toContain('whitespace-nowrap');
  });
});
