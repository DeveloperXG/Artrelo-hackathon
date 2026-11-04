import { Droplet, PaintBucket, Plug, Thermometer, Wrench, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PIE_COLORS } from '../requestHelpers';

/** A glyph for a request category. Categories are free text, so this matches loosely. */
export function categoryIcon(category?: string): LucideIcon {
  const c = (category || '').toLowerCase();
  if (c.includes('plumb') || c.includes('water') || c.includes('leak')) return Droplet;
  if (c.includes('electric') || c.includes('power') || c.includes('light')) return Zap;
  if (c.includes('hvac') || c.includes('heat') || c.includes('cool') || c.includes('air')) return Thermometer;
  if (c.includes('appliance')) return Plug;
  if (c.includes('paint')) return PaintBucket;
  return Wrench;
}

/** A stable colour per category name, so "Plumbing" is the same blue on every visit. */
export function categoryColor(category?: string): string {
  const s = category || 'general';
  const sum = Array.from(s).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return PIE_COLORS[sum % PIE_COLORS.length];
}

/**
 * Owner Lichen LIGHT values for the Overview charts, which render in the
 * light content scope: an explicit adapter that hands Recharts literal
 * colours rather than theme variables. lichenOverview.test.tsx fails if any
 * value drifts from the light role it stands for in theme.css.
 *
 * Lichen and Mist are fills here (area wash, donut, bars). A line or dot that
 * must be seen on white uses the readable role instead: lichen-icon for
 * Incoming, mist-text for Resolved.
 */
export const LICHEN_CHART = {
  lichen: '#b8c65a',
  /** Light lichen-icon: the Incoming line and dots (Lichen itself is 1.9:1 on white). */
  lichenLine: '#6b7a12',
  mist: '#7fa3bd',
  /** Light mist-text: the dashed Resolved line and dots. */
  mistStroke: '#2f5a78',
  mistLine: '#c9d9e5',
  closed: '#d3d8dc',
  /** Light muted: the readable outline that makes a Closed slice visible. */
  closedEdge: '#545c64',
  axis: '#545c64',
  grid: '#eceef0',
  surface: '#ffffff',
  border: '#e1e4e8',
  ink: '#0f1215',
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** Axis ticks: muted, Plex Mono figures. */
export const LICHEN_TICK = { fill: LICHEN_CHART.axis, fontSize: 12, fontFamily: LICHEN_CHART.mono };

/** Flat Lichen tooltip: white panel, border step, no shadow. */
export const LICHEN_TOOLTIP = {
  contentStyle: {
    background: LICHEN_CHART.surface,
    border: `1px solid ${LICHEN_CHART.border}`,
    borderRadius: 6,
    boxShadow: 'none',
    color: LICHEN_CHART.ink,
    fontSize: 12,
    padding: '8px 12px',
  },
  labelStyle: { color: LICHEN_CHART.ink, fontWeight: 600 },
  itemStyle: { color: LICHEN_CHART.ink, fontFamily: LICHEN_CHART.mono },
};

/** Legacy light tooltip, still used by the un-migrated Reports page. */
export const CHART_TOOLTIP_STYLE = {
  borderRadius: 12,
  border: '1px solid #e2e8f0',
  boxShadow: '0 12px 32px -12px rgba(15, 23, 42, 0.25)',
  fontSize: 12,
  padding: '8px 12px',
};
