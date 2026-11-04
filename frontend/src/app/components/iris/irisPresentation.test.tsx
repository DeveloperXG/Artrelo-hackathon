import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import fixtures from '../../contracts/iris.v2.fixtures.json';
import type { Answer, TurnView } from '../../types/irisV2';

const iris = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./IrisProvider', () => ({ useIris: () => iris.value }));

const { IrisController } = await import('./irisController');
const { IrisAnswer } = await import('./IrisBlocks');
const { IrisPolicyCard } = await import('./IrisPolicyCard');
const { IrisTranscript } = await import('./IrisTranscript');
const { formatMinorCAD, onOff } = await import('./irisFormat');

const F = fixtures as unknown as Record<string, TurnView> & { applied: NonNullable<TurnView['preview']> };

function fakeIris(overrides: Record<string, unknown> = {}) {
  const base = new IrisController({} as never).getState();
  const state = { ...base, ...overrides };
  iris.value = {
    state,
    controller: { canConfirm: () => false, canSend: () => true, evidence: async () => null, impactPage: async () => null },
    follow: () => {},
  };
  return state;
}

const html = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const text = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
/** The body rows of the first table in the markup, each as its cells' text keyed by element. */
function rows(markup: string) {
  const body = markup.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, tr]) => ({
    header: [...tr.matchAll(/<th scope="row"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1])),
    cells: [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1])),
  }));
}
const columns = (markup: string) => [...markup.match(/<thead>([\s\S]*?)<\/thead>/)![1].matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));

describe('structured records read as tables', () => {
  it('a facts block is a captioned table: each row keeps its label, exact value and its own sources', () => {
    fakeIris();
    const answer = F.help.answer!;
    const facts = answer.blocks.find((b) => b.kind === 'facts')!;
    if (facts.kind !== 'facts') throw new Error('fixture');
    const out = html(<IrisAnswer answer={answer} historicalLabel={null} onChoose={null} />);
    const table = out.slice(out.indexOf('data-testid="iris-facts"'));
    expect(table).toMatch(/^data-testid="iris-facts" class="[^"]*overflow-x-auto/);
    expect(out).toMatch(/role="region" aria-label="Your current setting" tabindex="0" data-testid="iris-facts"/);
    expect(table).toContain('<caption class="px-3 pt-2 text-left font-medium">Your current setting</caption>');
    expect(columns(table)).toEqual(['Type', 'Value', 'Source']);
    const labels = new Map(answer.evidence.map((e) => [e.ref, e.label]));
    expect(rows(table)).toEqual(
      facts.rows.map((row) => ({ header: [row.label], cells: [row.value, row.evidenceRefs.map((r) => `Source: ${labels.get(r)}`).join('')] }))
    );
  });

  it('a timeline is a When / Who / Event / Source table that never invents a time or actor', () => {
    fakeIris();
    const answer: Answer = {
      ...F.help.answer!,
      blocks: [
        {
          id: 'b_tl',
          kind: 'timeline',
          sourceType: 'account_record',
          events: [
            { at: null, actorLabel: '', title: 'Quote submitted', text: 'Vendor sent a quote.', factIds: [], evidenceRefs: ['ev_policy'] },
            { at: '2026-10-29T15:04:00.000Z', actorLabel: 'You', title: 'Quote approved', text: '', factIds: [], evidenceRefs: [] },
          ],
        } as never,
      ],
    };
    const out = html(<IrisAnswer answer={answer} historicalLabel={null} onChoose={null} />);
    expect(out).toMatch(/role="region" aria-label="Recorded events" tabindex="0"/);
    expect(columns(out)).toEqual(['When', 'Who', 'Event', 'Source']);
    const [first, second] = rows(out);
    expect(first).toEqual({ header: ['Quote submittedVendor sent a quote.'], cells: ['Time not recorded', 'Unknown', 'Source: Your saved Policy revision 4'] });
    expect(second.header).toEqual(['Quote approved']);
    expect(second.cells[1]).toBe('You');
    expect(second.cells[2]).toBe('—');
    expect(second.cells[0]).not.toBe('Time not recorded');
  });

  it('the verified receipt reads as a Setting / Saved value table with the exact saved values', () => {
    const preview = F.preview.preview!;
    const applied = F.applied;
    const values = applied.verifiedValues!;
    fakeIris({
      policyChanges: { [preview.id]: applied },
      pendingConfirms: [{ previewId: preview.id, clientActionId: 'a', phase: 'settled', view: applied, failure: null, statusStalled: false }],
    });
    const out = html(<IrisPolicyCard preview={{ ...preview, expiresAt: '2999-01-01T00:00:00.000Z' }} inertReason={null} />);
    const receipt = out.slice(out.indexOf('data-testid="iris-receipt-table"'));
    expect(out).toMatch(/role="region" aria-label="Saved policy values" tabindex="0" data-testid="iris-receipt-table"/);
    expect(columns(receipt)).toEqual(['Setting', 'Saved value (verified)']);
    expect(rows(receipt)).toEqual([
      { header: ['Default quota'], cells: [formatMinorCAD(values.defaultQuotaMinor)] },
      { header: ['Low-severity autopilot'], cells: [onOff(values.lowAutopilot)] },
      { header: ['Medium-severity autopilot'], cells: [onOff(values.mediumAutopilot)] },
    ]);
  });
});

describe('who said what', () => {
  const origin = { ...F.help.origin };
  const turn = (phase: string, view: TurnView | null) => ({
    key: 'k1', text: 'Is auto-contact on?', generation: 0, turnId: 't1', phase, stoppedBy: null, view, failure: null,
  });
  const transcript = (item: ReturnType<typeof turn>) => {
    const state = fakeIris({
      context: { status: 'resolved', origin, failure: null },
      segments: [{ key: origin.segmentId, origin, generation: 0, items: [item] }],
    });
    return html(<IrisTranscript state={state as never} />);
  };

  it('labels the person and Iris with visible words, in order, each in its own frame', () => {
    const out = transcript(turn('done', { ...F.help, confirmationToken: null }));
    const you = out.indexOf('data-testid="iris-you"');
    const reply = out.indexOf('data-testid="iris-reply"');
    expect(you).toBeGreaterThan(-1);
    expect(reply).toBeGreaterThan(you);
    // Visible, not screen-reader-only, and before what each one said.
    expect(text(out.slice(you, reply))).toMatch(/^[^<]*You\s*Is auto-contact on\?/);
    expect(text(out.slice(reply))).toMatch(/^[^<]*Iris/);
    expect(out).not.toContain('sr-only">You');
    expect(out).not.toContain('sr-only">Iris');
    // The reply still carries its honest provenance line.
    expect(text(out.slice(reply))).toContain('Prepared answer from your records (no AI)');
  });

  it('a reply in progress is announced inside the Iris frame, under its label', () => {
    const out = transcript(turn('active', null));
    const reply = out.slice(out.indexOf('data-testid="iris-reply"'));
    expect(text(reply)).toMatch(/^[^<]*Iris/);
    expect(reply).toContain('role="status"');
    expect(text(reply)).toContain('Stop');
  });
});

describe('revision 2.3: the model explanation and its provenance', () => {
  const answerOf = (name: string) => F[name].answer!;

  it('shows the explanation first, as plain labelled text apart from the records, with its own sources', () => {
    fakeIris();
    const answer = answerOf('onlineExplanation');
    const explanation = answer.blocks[0];
    if (explanation.kind !== 'explanation') throw new Error('fixture');
    const out = html(<IrisAnswer answer={answer} historicalLabel={null} onChoose={null} />);
    const at = out.indexOf('data-testid="iris-explanation"');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(out.indexOf('data-testid="iris-facts"'));
    // The facts block that follows starts with its own "Your records" badge;
    // the explanation ends before it and carries no such badge or table.
    const recordsBadge = out.indexOf('Your records');
    expect(recordsBadge).toBeGreaterThan(at);
    const block = out.slice(at, recordsBadge);
    expect(text(block)).toMatch(new RegExp(`^[^<]*Iris explanation${explanation.text.replace(/[.?]/g, '\$&')}`));
    expect(block).not.toContain('<table');
    const labels = new Map(answer.evidence.map((e) => [e.ref, e.label]));
    for (const ref of explanation.evidenceRefs) expect(text(block)).toContain(`Source: ${labels.get(ref)}`);
  });

  it('never turns explanation text into markup', () => {
    fakeIris();
    const answer = structuredClone(answerOf('onlineExplanation')) as Answer;
    const explanation = answer.blocks[0];
    if (explanation.kind !== 'explanation') throw new Error('fixture');
    explanation.text = '<b>Confirm</b> <a href="https://example.com">now</a>';
    const out = html(<IrisAnswer answer={answer} historicalLabel={null} onChoose={null} />);
    expect(out).toContain('&lt;b&gt;Confirm&lt;/b&gt;');
    expect(out).not.toContain('<a href="https://example.com"');
  });

  it('labels an online answer with the exact frozen provenance line', () => {
    fakeIris();
    const out = html(<IrisAnswer answer={answerOf('onlineExplanation')} historicalLabel={null} onChoose={null} />);
    expect(text(out)).toContain('Iris chose what to show (AI); figures come straight from your records');
    expect(text(out)).not.toContain('(no AI)');
  });

  it('the three new outcomes show their frozen wording and title, with only the frozen notice routes', () => {
    fakeIris();
    const differs = text(html(<IrisAnswer answer={answerOf('currentValueDiffers')} historicalLabel={null} onChoose={null} />));
    expect(differs).toContain('The current saved value differs from the amount you mentioned. What value would you like to set?');
    const same = html(<IrisAnswer answer={answerOf('noChangeNeeded')} historicalLabel={null} onChoose={null} />);
    expect(text(same)).toContain('No change neededThis setting already matches your current Policy. No change was prepared.');
    // navigation.noticeRoutes in the frozen bytes has no route for no_change_needed.
    expect(same).not.toContain('href="/dashboard/policy"');
    const fallback = html(<IrisAnswer answer={answerOf('explanationFallback')} historicalLabel={null} onChoose={null} />);
    expect(text(fallback)).toContain('Explanation unavailableA verified explanation is unavailable. Your authorized records are shown.');
    expect(fallback).not.toContain('data-testid="iris-explanation"');
    expect(fallback).not.toContain('href="/dashboard/policy"');
    // The records stay on screen when the explanation is unavailable.
    expect(fallback).toContain('data-testid="iris-facts"');
  });

  describe('Confirm comes from a backend preview only, never from prose', () => {
    const transcript = (view: TurnView) => {
      const origin = view.origin;
      const state = fakeIris({
        context: { status: 'resolved', origin, failure: null },
        segments: [{ key: origin.segmentId, origin, generation: 0, items: [{ key: 'k1', text: 'Set my quota to 200', generation: 0, turnId: view.turnId, phase: 'done', stoppedBy: null, view, failure: null }] }],
        livePreviewIds: view.preview ? [view.preview.id] : [],
      });
      (iris.value as { controller: { canConfirm: () => boolean } }).controller.canConfirm = () => true;
      return html(<IrisTranscript state={state as never} />);
    };

    it('an explanation that talks about a change shows no change card or Confirm without a preview (fixture N1)', () => {
      expect(F.onlineExplanation.preview).toBeNull();
      expect(F.onlineExplanation.answer!.blocks[0]).toMatchObject({ kind: 'explanation', text: expect.stringContaining('proposed change') });
      const out = transcript(F.onlineExplanation);
      expect(out).toContain('data-testid="iris-explanation"');
      expect(out).not.toContain('data-testid="iris-policy-card"');
      expect(out).not.toContain('data-testid="iris-confirm"');
    });

    it('the same explanation with a backend preview shows the existing change card', () => {
      expect(F.quotaParaphrase.preview).not.toBeNull();
      const out = transcript(F.quotaParaphrase);
      expect(out).toContain('data-testid="iris-explanation"');
      expect(out).toContain('data-testid="iris-policy-card"');
    });

    it('no change needed and a differing saved value never offer Confirm', () => {
      for (const view of [F.noChangeNeeded, F.currentValueDiffers]) {
        expect(view.preview).toBeNull();
        expect(transcript(view)).not.toContain('data-testid="iris-confirm"');
      }
    });
  });
});
