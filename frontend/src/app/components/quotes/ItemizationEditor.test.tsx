import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ItemizationEditor from './ItemizationEditor';
import ItemizationBreakdown from './ItemizationBreakdown';
import { emptyLine, type DraftLine } from '../../lib/itemization';
import { validateAcceptForm } from '../../pages/vendor/acceptForm';

const line = (patch: Partial<DraftLine>): DraftLine => ({ ...emptyLine(), ...patch });
const noop = () => {};

describe('itemization editor', () => {
  it('fixed mode: one amount per line, a running exact total, and the only line cannot be removed', () => {
    const html = renderToStaticMarkup(
      <ItemizationEditor idPrefix="q" mode="fixed" onModeChange={noop} lines={[line({ amount: '0.10' })]} onLinesChange={noop} />
    );
    expect(html).toContain('Amount (CAD)');
    expect(html).not.toContain('Low (CAD)');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove line 1"/);
    expect(html).toContain('<strong class="tabular-nums text-slate-900">$0.10</strong>');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Exact amounts');
  });

  it('range mode: low and high per line, totals both ends, removable when more than one', () => {
    const html = renderToStaticMarkup(
      <ItemizationEditor
        idPrefix="q"
        mode="range"
        onModeChange={noop}
        lines={[line({ low: '100', high: '150' }), line({ low: '20.50', high: '20.50' })]}
        onLinesChange={noop}
      />
    );
    expect(html).toContain('Low (CAD)');
    expect(html).toContain('High (CAD)');
    expect(html).toContain('$120.50–$170.50');
    expect(html).toContain('aria-label="Remove line 2"');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove line \d"/);
  });

  it('a locked mode (final statement) offers no range option', () => {
    const html = renderToStaticMarkup(<ItemizationEditor idPrefix="f" mode="fixed" lines={[line({})]} onLinesChange={noop} />);
    expect(html).not.toContain('Price ranges');
  });

  it('shows line errors beside their inputs with aria wiring', () => {
    const a = line({});
    const html = renderToStaticMarkup(
      <ItemizationEditor idPrefix="q" mode="fixed" lines={[a]} onLinesChange={noop} lineErrors={{ [a.key]: { description: 'Describe this line.' } }} />
    );
    expect(html).toContain('Describe this line.');
    expect(html).toContain(`aria-describedby="q-${a.key}-description-error"`);
    expect(html).toContain('aria-invalid="true"');
  });

  it('the read-only breakdown shows every line and the total', () => {
    const html = renderToStaticMarkup(
      <ItemizationBreakdown
        itemization={{ pricingMode: 'fixed', currency: 'CAD', items: [{ lineId: 'a', description: 'Labour', category: 'labour', amountMinor: 18000 }], totals: { lowMinor: 18000, highMinor: 18000 } }}
        title="Final statement"
      />
    );
    expect(html).toContain('Labour');
    expect(html).toContain('$180.00 CAD');
  });
});

describe('accept form: itemized versus legacy price inputs', () => {
  const base = { slot: undefined, arrivalDate: '', arrivalTime: '', durationMinutes: '120', customHours: '', customMinutes: '0' };
  it('legacy outreach still needs a low and high estimate', () => {
    const result = validateAcceptForm({ ...base, quoteLow: '', quoteHigh: '' });
    expect(result.errors?.quote).toBe('Enter both a low and a high estimate.');
  });
  it('itemized outreach does not ask for low/high (the line editor checks the price)', () => {
    const result = validateAcceptForm({ ...base, quoteLow: '', quoteHigh: '', itemized: true });
    expect(result.errors?.quote).toBeUndefined();
  });
});
