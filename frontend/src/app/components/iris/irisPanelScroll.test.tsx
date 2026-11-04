import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import fixtures from '../../contracts/iris.v2.fixtures.json';
import type { Answer, TurnView } from '../../types/irisV2';

const mock = vi.hoisted(() => ({ iris: null as unknown, away: false, unseen: false, latest: null as unknown }));
vi.mock('./IrisProvider', () => ({ useIris: () => mock.iris }));
vi.mock('./irisScroll', () => ({ useTranscriptFollow: (_scroll: unknown, _content: unknown, latest: unknown) => {
  mock.latest = latest;
  return { away: mock.away, unseen: mock.unseen, jump: () => {} };
} }));
const { IrisController } = await import('./irisController');
const { IrisPanel } = await import('./IrisPanel');
const F = fixtures as unknown as Record<string, TurnView>;

function panel(answer: Answer | null, away = false, unseen = false) {
  mock.away = away; mock.unseen = unseen;
  const base = new IrisController({} as never).getState();
  const origin = { segmentId: 'segment', contextGeneration: 1, requestContextId: 'request_a', contextKind: 'request' as const, contextLabel: 'Owned request A' };
  mock.iris = {
    state: { ...base, open: true, context: { status: 'resolved', origin }, segments: [{ key: 'segment', generation: base.generation, origin, items: [{ key: 'turn', phase: 'done', text: 'Show my records', view: { ...F.history, answer }, turnId: 'turn_owned' }] }] },
    dock: { docked: true, width: 560, min: 400, max: 760 }, draft: { current: '', epoch: base.draftEpoch },
    controller: { canSend: () => true }, setPanelWidth: () => {}, closePanel: () => {}, takeCloseFocus: () => 'launcher',
  };
  return renderToStaticMarkup(<MemoryRouter><IrisPanel /></MemoryRouter>);
}

describe('actual Iris panel scroll-policy wiring', () => {
  it('offers the native Jump button while away even when no new answer arrived', () => {
    const out = panel(null, true, false);
    expect(out).toMatch(/<button[^>]*type="button"[^>]*>Jump to bottom<\/button>/);
    expect(out).not.toContain('iris-new-response');
    expect(panel(null, false)).not.toContain('Jump to bottom');
  });
  it('marks mixed and fact-only record answers for preservation; guides alone keep normal follow', () => {
    panel(F.onlineExplanation.answer!);
    expect(mock.latest).toMatchObject({ key: 'turn', records: true });
    const guide = F.help.answer!.blocks.filter((b) => b.kind !== 'explanation' && b.sourceType === 'product_guide');
    panel({ ...F.help.answer!, blocks: guide });
    expect(mock.latest).toMatchObject({ records: false });
    const policy = F.help.answer!.blocks.filter((b) => b.kind === 'facts');
    panel({ ...F.help.answer!, blocks: policy });
    expect(mock.latest).toMatchObject({ records: true });
  });
  it('detects record replacement within the same completed turn and retains the exact context label', () => {
    const answer = structuredClone(F.help.answer!);
    panel(answer);
    const before = mock.latest as { key: string; signature: string };
    const facts = answer.blocks.find((b) => b.kind === 'facts');
    if (!facts || facts.kind !== 'facts') throw Error('fixture');
    facts.rows[0].value = 'CAD 0.00; unknown payment status';
    const out = panel(answer, true, true);
    const after = mock.latest as { key: string; signature: string };
    expect(after.key).toBe(before.key);
    expect(after.signature).not.toBe(before.signature);
    expect(out).toContain('Owned request A');
    expect(out).toContain('New response');
    expect(out).toContain('Jump to bottom');
  });
});
