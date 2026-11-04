import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatGrid } from './StatCard';

describe('StatGrid', () => {
  it('takes its columns from the page column, not the viewport', () => {
    const html = renderToStaticMarkup(<StatGrid className="mb-6">x</StatGrid>);
    expect(html).toContain('@min-[38rem]/page:grid-cols-2');
    expect(html).toContain('lg:@min-[58rem]/page:grid-cols-4');
    expect(html).not.toMatch(/\b(sm|xl):grid-cols/);
  });

  it('lets a page override the wide column count', () => {
    const html = renderToStaticMarkup(<StatGrid className="lg:@min-[58rem]/page:grid-cols-3">x</StatGrid>);
    expect(html).toContain('lg:@min-[58rem]/page:grid-cols-3');
    expect(html).not.toContain('lg:@min-[58rem]/page:grid-cols-4');
  });
});
