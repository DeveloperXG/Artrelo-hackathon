import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IrisAnswer } from './IrisBlocks';
import { evidenceMeta } from './IrisEvidencePeek';
import type { Answer, Block, Evidence } from '../../types/irisV2';

vi.mock('./IrisProvider', () => ({ useIris: () => null }));
const source = (ref: string, kind: Evidence['kind'], requestId: string | null = 'request_a'): Evidence => ({
  ref, kind, requestId, recordId: ref, routeKind: 'none', publicRouteKind: null,
  revision: 2, hash: null, occurredAt: '2026-11-03T15:04:00Z', lastVerifiedAt: null, label: ref,
});
const facts = (id: string, title: string | null, values: [string, string, string][]): Block => ({
  id, kind: 'facts', sourceType: 'account_record', title,
  rows: values.map(([label, value, ref]) => ({ label, value, factIds: [], evidenceRefs: [ref] })),
});
function answer(blocks: Block[], evidence: Evidence[]): Answer {
  return { blocks, evidence, coverage: 'partial', source: 'deterministic_records', model: null, observedAt: '2026-11-03T15:04:00Z' };
}
const html = (value: Answer) => renderToStaticMarkup(<IrisAnswer answer={value} historicalLabel={null} onChoose={null} />);

describe('compact record answers preserve backend truth and exact sources', () => {
  it('groups repeated Decisions and Visits once without losing stages, lineage, parties or deadlines', () => {
    const values: [string, string, string][] = [
      ['Quote scope review', 'Rejected; reopened from decision_a; no spend or payment approval', 'quote'],
      ['Final statement scope review', 'Allowed; CAD 0.00 approved payable; pending_manual, no bank receipt', 'final'],
      ['Scope review (stage not recorded)', 'Unknown legacy stage; not inferred as quote or invoice', 'legacy'],
    ];
    const visitValues: [string, string, string][] = [
      ['Status and reason', 'Awaiting exact-party consent; manager supplied reason', 'visit'],
      ['Original visit', 'Nov 3, 2026, 3:04 PM UTC; retained on refusal or expiry', 'visit'],
      ['Replacement visit', 'Nov 4, 2026, 10:00 AM America/Toronto', 'visit'],
      ['Vendor response', 'Accepted', 'visit'], ['Tenant response', 'Pending', 'visit'],
      ['Response deadline', 'Nov 3, 2026, 1:04 PM UTC; minimum 15-minute response window', 'visit'],
      ['Cutoff', '2 hours before the earlier visit', 'visit'],
    ];
    const evidence = [source('quote', 'decision'), source('final', 'decision'), source('legacy', 'decision'), source('visit', 'scheduling_event')];
    const out = html(answer([
      facts('d1', 'Recorded decisions and policy evidence', values.slice(0, 1)),
      facts('v1', 'Visit changes', visitValues.slice(0, 3)),
      facts('d2', 'Recorded decisions and policy evidence', values.slice(1)),
      facts('v2', 'Visit changes', visitValues.slice(3)),
    ], evidence));
    expect(out.match(/data-testid="iris-records-group"/g)).toHaveLength(1);
    expect(out.match(/<h4[^>]*>Decisions<\/h4>/g)).toHaveLength(1);
    expect(out.match(/<h4[^>]*>Visits<\/h4>/g)).toHaveLength(1);
    expect(out).toContain('aria-label="Request records"');
    for (const [label, value, ref] of [...values, ...visitValues]) {
      expect(out).toContain(label); expect(out).toContain(value); expect(out).toContain(`Source: ${ref}`);
    }
    expect(out).toContain('Partial: some records were not included');
    expect(out).toContain('>Type</th>');
    expect(out).not.toContain('>Confirm</button>');
  });
  it('keeps Events, Costs, explanation and published guide distinct without dropping an evidence action', () => {
    const out = html(answer([
      { id: 'explain', kind: 'explanation', text: 'AI explanation only; not approval.', factIds: [], evidenceRefs: ['decision'] },
      { id: 'events', kind: 'timeline', sourceType: 'account_record', events: [{ at: '2026-11-03T15:04:00Z', actorLabel: 'Automation', title: 'Recorded event', text: 'Canonical concise event', factIds: [], evidenceRefs: ['decision'] }] },
      { id: 'guide', kind: 'paragraph', sourceType: 'product_guide', text: 'Published Policy guide', factIds: [], evidenceRefs: ['guide'] },
      { id: 'costs', kind: 'cost_table', sourceType: 'account_record', caption: 'Recorded costs, not bank-payment verification', columns: ['Recorded'], rows: [{ label: 'Total', cells: [{ text: 'CAD 0.00', minor: 0, currency: 'CAD', factIds: [], evidenceRefs: ['cost'] }] }], footerRows: [] },
    ], [source('decision', 'audit'), source('guide', 'help_article', null), source('cost', 'final_statement')]));
    expect(out.match(/data-testid="iris-records-group"/g)).toHaveLength(1);
    for (const text of ['>Events</h4>', '>Costs</h4>', 'Iris explanation', '>Product guide<', 'Published Policy guide', 'Source: decision', 'Source: guide', 'Source: cost', 'CAD 0.00', 'Nov 3, 2026, 3:04 PM UTC', 'dateTime="2026-11-03T15:04:00Z"']) expect(out).toContain(text);
    expect(out.indexOf('Iris explanation')).toBeLessThan(out.indexOf('data-testid="iris-records-group"'));
  });
  it('labels account-only Policy accurately, retaining empty and unknown records without inventing a request', () => {
    const policy = html(answer([facts('policy', 'Your current setting', [['Default quota', 'CAD 0.00', 'policy']])], [source('policy', 'policy_revision', null)]));
    expect(policy).toContain('aria-label="Account Policy records"');
    expect(policy).not.toContain('Request records');
    const unknown = html(answer([facts('empty', null, [])], []));
    expect(unknown).toContain('aria-label="Records"');
    expect(unknown).toContain('Other records');
    expect(unknown).not.toContain('CAD');
    expect(html(answer([], []))).not.toContain('iris-records-group');
  });
  it('uses the identical explicit UTC style in source metadata, keeping raw evidence untouched', () => {
    const e = source('decision', 'decision');
    expect(evidenceMeta(e)).toBe('Decision · revision 2 · Nov 3, 2026, 3:04 PM UTC');
    expect(e.occurredAt).toBe('2026-11-03T15:04:00Z');
  });
});
