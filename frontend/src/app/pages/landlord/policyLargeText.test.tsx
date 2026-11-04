import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Send } from 'lucide-react';
import PolicyPage from './PolicyPage';
import StatCard from '../../components/landlord/StatCard';

// Observed at 320 px with 200% text: the page scrolled sideways to 367 px,
// pushed by the switch rows, the summary tiles and long description words.
// The correction only changes layout when a row cannot hold its content.

vi.mock('../../hooks/landlord/useLandlordBadges', () => ({ useLandlordPaymentMode: () => 'platform' }));
vi.mock('../../hooks/landlord/useLandlordPolicy', () => ({ useLandlordPolicy: () => ({ policy: { defaultQuota: 200,
  lowFundsThreshold: 100, maxOutreachAttempts: 3, autoAdvanceOnVendorDecline: true, allowAutopilotForLowSeverity: true,
  allowAutopilotForMediumSeverity: true }, setPolicy: vi.fn(), loading: false, reload: vi.fn() }) }));
vi.mock('../../hooks/landlord/useRoutingSetup', () => ({ useRoutingSetup: () => ({ setup: null, reload: vi.fn() }) }));

const html = () => renderToStaticMarkup(<MemoryRouter><PolicyPage /></MemoryRouter>);

describe('Policy page holds at 320 px with 200% text', () => {
  it('lets every switch drop under its label only when the row is too narrow', () => {
    const markup = html();
    const switches = [...markup.matchAll(/<button type="button" role="switch"[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(switches.length).toBeGreaterThanOrEqual(6);
    for (const c of switches) {
      expect(c).toContain('flex-wrap');
      expect(c).toContain('[overflow-wrap:anywhere]');
    }
    expect(markup.match(/class="min-w-0 flex-\[1_1_6rem\]"><span class="flex flex-wrap items-center gap-1\.5/g)?.length).toBe(switches.length);
  });

  it('wraps the summary tiles, the emergency note, the vendor cap and section descriptions', () => {
    const markup = html();
    expect(markup.match(/class="flex-wrap ll-fade-up group flex/g)?.length).toBe(4);
    expect(markup).toMatch(/text-slate-600 \[overflow-wrap:anywhere\]">.*?Emergency requests are never auto-routed/s);
    expect(markup).toMatch(/<label class="min-w-0 space-y-1\.5[^"]*\[overflow-wrap:anywhere\]">\s*<span class="block text-sm font-semibold text-slate-800[^"]*">Max vendors contacted per request/);
    expect(markup.match(/\[&amp;_p\]:\[overflow-wrap:anywhere\]/g)?.length).toBe(4);
  });
});

describe('StatCard wrap', () => {
  it('only a wrapping tile may move its icon above the figures', () => {
    const plain = renderToStaticMarkup(<StatCard icon={Send} label="Vendor auto-contact" value="On" />);
    expect(plain).not.toContain('flex-wrap ll-fade-up');
    expect(plain).toContain('class="min-w-0 flex-1"');
    const wrapping = renderToStaticMarkup(<StatCard icon={Send} label="Vendor auto-contact" value="On" wrap />);
    expect(wrapping).toContain('flex-wrap ll-fade-up');
    expect(wrapping).toContain('class="min-w-0 flex-[1_1_6rem]"');
  });
});
