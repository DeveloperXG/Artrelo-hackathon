import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LICHEN_CHART } from './categoryVisuals';
import { STATUS_GROUPS, statusBreakdown } from './overviewData';
import RequestStatusCard from './RequestStatusCard';
import DecisionsBanner from './DecisionsBanner';

// categoryVisuals.ts adapts the palette to literal chart colours. The charts
// render in the Lichen LIGHT content scope, so each literal must stay the
// value its light role resolves to in theme.css.
const theme = readFileSync(new URL('../../../../styles/theme.css', import.meta.url), 'utf8');
const owner = (name: string) => theme.match(new RegExp(`--artrelo-${name}:\\s*(#[0-9a-f]{6});`))![1];
const lightBlock = theme.match(/\n\.lichen\.lichen-light\s*\{([\s\S]*?)\n\}/)![1];
/** The literal a --role-* resolves to inside .lichen.lichen-light. */
const light = (role: string) => {
  const primitive = lightBlock.match(new RegExp(`--role-${role}:\\s*var\\(--artrelo-([\\w-]+)\\);`))![1];
  return owner(primitive);
};

function contrast(a: string, b: string) {
  const lum = (hex: string) =>
    [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('Overview chart colours (Lichen)', () => {
  it('mirror the light scope roles exactly (drift test)', () => {
    expect(LICHEN_CHART.lichen).toBe(light('lichen'));
    expect(LICHEN_CHART.lichenLine).toBe(light('lichen-icon'));
    expect(LICHEN_CHART.mist).toBe(light('mist'));
    expect(LICHEN_CHART.mistStroke).toBe(light('mist-text'));
    expect(LICHEN_CHART.mistLine).toBe(light('mist-line'));
    expect(LICHEN_CHART.closed).toBe(light('closed'));
    expect(LICHEN_CHART.closedEdge).toBe(light('meta'));
    expect(LICHEN_CHART.axis).toBe(light('meta'));
    expect(LICHEN_CHART.grid).toBe(light('hairline'));
    expect(LICHEN_CHART.surface).toBe(light('surface'));
    expect(LICHEN_CHART.ink).toBe(light('ink'));
    expect(LICHEN_CHART.border).toBe(owner('light-border'));
  });

  it('give the status groups the owner roles: Lichen open, Mist completed, Closed closed', () => {
    expect(STATUS_GROUPS.map((group) => [group.key, group.color])).toEqual([
      ['open', light('lichen')],
      ['completed', light('mist')],
      ['closed', light('closed')],
    ]);
  });

  it('never leaves Closed to its fill alone: the fill fails 3:1, so the outline and legend carry it', () => {
    expect(contrast(LICHEN_CHART.closed, LICHEN_CHART.surface)).toBeLessThan(3);
    expect(contrast(LICHEN_CHART.closedEdge, LICHEN_CHART.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(LICHEN_CHART.closedEdge, LICHEN_CHART.closed)).toBeGreaterThanOrEqual(3);
    expect(contrast(LICHEN_CHART.axis, LICHEN_CHART.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('draws the lines in readable roles, never the Lichen fill, on white', () => {
    expect(contrast(LICHEN_CHART.lichen, LICHEN_CHART.surface)).toBeLessThan(3);
    expect(contrast(LICHEN_CHART.lichenLine, LICHEN_CHART.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(LICHEN_CHART.mistStroke, LICHEN_CHART.surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('RequestStatusCard', () => {
  it('names every group in text with its count and share, in Mono', () => {
    const html = renderToStaticMarkup(<RequestStatusCard byStatus={{ submitted: 2, completed: 1, cancelled: 1 }} />);
    const { groups } = statusBreakdown({ submitted: 2, completed: 1, cancelled: 1 });
    for (const group of groups) {
      const row = html.match(new RegExp(`<li[^>]*data-testid="overview-status-${group.key}"[\\s\\S]*?</li>`))![0];
      expect(row).toContain(group.label);
      expect(row).toMatch(new RegExp(`font-mono[^"]*">${group.value}<`));
      expect(row).toContain(`${group.percent}%`);
    }
    // Only the scoped card shadow (none in dark, 1px on light).
    expect(html.replace(/lichen:shadow-lichen-card/g, '')).not.toMatch(/shadow-/);
  });
});

describe('DecisionsBanner', () => {
  it('says the count in words beside an attention icon, on the Lichen wash', () => {
    const html = renderToStaticMarkup(<DecisionsBanner total={2} onReview={() => {}} />);
    expect(html).toContain('aria-label="Decisions needing review"');
    expect(html).toContain('<span class="font-mono">2</span> decisions need your review');
    expect(html).toContain('bg-lichen-wash');
    expect(html).toContain('lucide-triangle-alert');
    // The icon sits on light content: lichen-icon, never the Lichen fill as an icon.
    expect(html).toContain('text-lichen-icon');
    expect(html).not.toMatch(/\btext-lichen\b(?!-)/);
  });
});
