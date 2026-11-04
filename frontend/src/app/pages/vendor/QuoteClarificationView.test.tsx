import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { QuoteClarificationData } from '../../api/client';
import {
  ClarificationContent,
  buildClarificationSubmission,
  clarificationFailure,
  isClarificationLink,
} from './QuoteClarificationView';
import { emptyLine, linesFromItemization, type Itemization } from '../../lib/itemization';

const HASH = 'b'.repeat(64);
const itemization: Itemization = {
  pricingMode: 'fixed',
  currency: 'CAD',
  items: [
    { lineId: 'l1', description: 'Trap replacement', category: 'labour', amountMinor: 12000 },
    { lineId: 'l2', description: 'Trap kit', category: 'materials', amountMinor: 3500 },
  ],
  totals: { lowMinor: 15500, highMinor: 15500 },
};
const data = (patch: Partial<QuoteClarificationData> = {}): QuoteClarificationData => ({
  stage: 'quote',
  quoteRevision: 1,
  quoteHash: HASH,
  expiresAt: '2026-10-29T17:00:00.000Z',
  questions: [
    { id: 'q1', code: 'possible_duplicate', lineIds: ['l1', 'l2'], text: 'Explain how these charges differ and what each covers.' },
  ],
  quote: { quoteContractVersion: 2, revision: 1, hash: HASH, itemization },
  allowRevision: true,
  ...patch,
});

describe('clarification mode is selected by the link, not the brief', () => {
  it('selects on ?mode=quote-clarification or a qc_ token only', () => {
    expect(isClarificationLink('abc', 'quote-clarification')).toBe(true);
    expect(isClarificationLink('qc_123_abc', null)).toBe(true);
    expect(isClarificationLink('abc', null)).toBe(false);
    expect(isClarificationLink('abc', 'quote')).toBe(false);
  });

  it('the route renders the clarification surface and never the job brief', async () => {
    vi.resetModules();
    const getBrief = vi.fn(() => new Promise(() => {}));
    const getQuoteClarification = vi.fn(() => new Promise(() => {}));
    vi.doMock('../../api/client', async (original) => ({
      ...(await original<typeof import('../../api/client')>()),
      VendorPortalAPI: { getBrief, getQuoteClarification, respond: vi.fn() },
    }));
    const { default: VendorResponsePage } = await import('./VendorResponsePage');
    const render = (path: string) =>
      renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/vendor-response/:token" element={<VendorResponsePage />} />
          </Routes>
        </MemoryRouter>
      );
    expect(render('/vendor-response/tok?mode=quote-clarification')).toContain('Loading the follow-up');
    expect(render('/vendor-response/qc_aaaa')).toContain('Loading the follow-up');
    expect(render('/vendor-response/tok')).toContain('Loading job request');
    vi.doUnmock('../../api/client');
  });
});

describe('the clarification reply', () => {
  it('echoes the exact revision and hash with one trimmed answer per question', () => {
    const result = buildClarificationSubmission(data(), { q1: '  The kit is parts; the labour is fitting it.  ' }, { revise: false, mode: 'fixed', lines: [] });
    expect(result).toEqual({
      ok: true,
      body: {
        expectedQuoteRevision: 1,
        expectedQuoteHash: HASH,
        answers: [{ questionId: 'q1', answer: 'The kit is parts; the labour is fitting it.' }],
      },
    });
  });

  it('requires every answer and caps each at 800 characters', () => {
    const empty = buildClarificationSubmission(data(), { q1: '   ' }, { revise: false, mode: 'fixed', lines: [] });
    expect(empty).toMatchObject({ ok: false, answerErrors: { q1: 'Answer this question.' } });
    const long = buildClarificationSubmission(data(), { q1: 'x'.repeat(801) }, { revise: false, mode: 'fixed', lines: [] });
    expect(long).toMatchObject({ ok: false, answerErrors: { q1: expect.stringContaining('800') } });
  });

  it('sends a revision only when allowed and chosen, keeping owned lineIds and omitting new ones', () => {
    const lines = linesFromItemization(itemization);
    lines[1] = { ...lines[1], amount: '30.00' };
    const added = { ...emptyLine(), description: 'Disposal', category: 'disposal' as const, amount: '5' };
    const result = buildClarificationSubmission(data(), { q1: 'Kit was double counted.' }, { revise: true, mode: 'fixed', lines: [...lines, added] });
    if (!result.ok) throw new Error('expected ok');
    expect(result.body.itemization).toEqual({
      pricingMode: 'fixed',
      currency: 'CAD',
      items: [
        { lineId: 'l1', description: 'Trap replacement', category: 'labour', amountMinor: 12000 },
        { lineId: 'l2', description: 'Trap kit', category: 'materials', amountMinor: 3000 },
        { description: 'Disposal', category: 'disposal', amountMinor: 500 },
      ],
      totals: { lowMinor: 15500, highMinor: 15500 },
    });
  });

  it('never sends an itemization when revision is locked or for a final statement', () => {
    const lines = linesFromItemization(itemization);
    for (const locked of [data({ allowRevision: false }), data({ stage: 'invoice', allowRevision: true })]) {
      const result = buildClarificationSubmission(locked, { q1: 'Answer.' }, { revise: true, mode: 'fixed', lines });
      expect(result.ok && 'itemization' in result.body).toBe(false);
    }
  });
});

describe('final states are honest and never resubmit', () => {
  it.each([
    [410, 'expired', /expired/],
    [409, 'changed', /already answered or has changed/],
    [404, 'invalid', /not valid/],
    [undefined, 'invalid', /not valid/],
  ])('%s -> %s', (status, kind, title) => {
    const failure = clarificationFailure(status as number | undefined);
    expect(failure.kind).toBe(kind);
    expect(failure.title).toMatch(title);
  });
});

describe('what the vendor sees', () => {
  const noop = () => {};
  const base = {
    answers: {},
    onAnswer: noop,
    answerErrors: {},
    revise: false,
    onReviseChange: noop,
    mode: 'fixed' as const,
    lines: [],
    onLinesChange: noop,
    lineErrors: {},
    onClearLineError: noop,
    formError: '',
    busy: false,
    onSubmit: noop,
  };

  it('shows the questions, the flagged lines and the revision option when allowed', () => {
    const html = renderToStaticMarkup(<ClarificationContent {...base} phase={{ kind: 'ready', data: data() }} />);
    expect(html).toContain('Questions about your quote');
    expect(html).toContain('Explain how these charges differ');
    expect(html).toContain('About: Trap replacement; Trap kit');
    expect(html).toContain('data-testid="clarification-revise"');
    expect(html).toContain('Allowed once, before booking');
    expect(html).not.toContain(HASH);
  });

  it('locks revision on a final statement and when the server disallows it', () => {
    const invoice = renderToStaticMarkup(<ClarificationContent {...base} phase={{ kind: 'ready', data: data({ stage: 'invoice' }) }} />);
    expect(invoice).toContain('Final charges can’t be changed here');
    expect(invoice).not.toContain('clarification-revise"');
    const locked = renderToStaticMarkup(<ClarificationContent {...base} phase={{ kind: 'ready', data: data({ allowRevision: false }) }} />);
    expect(locked).toContain('This quote can’t be revised here');
  });

  it('success says pending review, never approved or booked', () => {
    const html = renderToStaticMarkup(<ClarificationContent {...base} phase={{ kind: 'answered', revision: 2, revised: true }} />);
    expect(html).toContain('revision 2');
    expect(html).toContain('Nothing is approved or booked yet');
    expect(html).toContain('can’t be used again');
  });

  it('an expired link is a final state with no form', () => {
    const html = renderToStaticMarkup(<ClarificationContent {...base} phase={{ kind: 'failed', failure: clarificationFailure(410) }} />);
    expect(html).toContain('clarification-final-expired');
    expect(html).not.toContain('clarification-submit');
  });
});
