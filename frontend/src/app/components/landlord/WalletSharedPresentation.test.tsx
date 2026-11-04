import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import StatCard from './StatCard';
import FilterChips from './FilterChips';
import TablePagination from './TablePagination';

describe('optional Wallet/Schedule presentation contracts', () => {
  it('retains default entrance/delay and identical figure/label/action when explicitly opting out', () => {
    const onClick = vi.fn(), props = { icon: Wallet, label: 'Recorded costs', value: '$0.00', sub: 'Includes pending payments', delay: 120, onClick, active: true };
    const original = StatCard(props), staticCard = StatCard({ ...props, entrance: false });
    expect(original.props.style).toEqual({ animationDelay: '120ms' }); expect(original.props.className).toContain('ll-fade-up');
    expect(staticCard.props.style).toBeUndefined(); expect(staticCard.props.className).not.toContain('ll-fade-up');
    expect(staticCard.props['aria-pressed']).toBe(true); staticCard.props.onClick(); expect(onClick).toHaveBeenCalledOnce();
    for (const card of [original, staticCard]) { const html = renderToStaticMarkup(card); for (const value of ['$0.00', 'Recorded costs', 'Includes pending payments']) expect(html).toContain(value); }
  });
  it.each([undefined, true])('keeps complete filter names/selection and exact click argument with presentation=%s', presentation => {
    const onChange = vi.fn(), tree = FilterChips({ options: [{ key: 'all', label: 'All transactions' }, { key: 'paid', label: 'Vendor payments', count: 0 }], value: 'paid', onChange, presentation });
    const buttons = tree.props.children; expect(buttons[0].props['aria-pressed']).toBe(false); expect(buttons[1].props['aria-pressed']).toBe(true); buttons[0].props.onClick(); expect(onChange).toHaveBeenCalledExactlyOnceWith('all');
    const html = renderToStaticMarkup(tree); expect(html).toContain('Vendor payments'); expect(html).toContain('>0</span>');
  });
  it.each([undefined, true])('keeps pagination current/disabled names and page values with presentation=%s', presentation => {
    const onPageChange = vi.fn(); const html = renderToStaticMarkup(<MemoryRouter><TablePagination page={1} totalPages={3} total={45} from={1} to={20} noun="transactions" onPageChange={onPageChange} presentation={presentation}/></MemoryRouter>);
    expect(html).toContain('aria-label="Pagination"'); expect(html).toContain('Showing 1–20 of 45 transactions'); expect(html).toMatch(/aria-label="Previous page" disabled/); expect(html).toContain('aria-current="page"');
  });
});
