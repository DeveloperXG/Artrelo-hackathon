import { describe, expect, it, vi } from 'vitest';
import { DOCK, dockLayout, dragResize, keyResize } from './irisDock';

describe('Iris dock sizing', () => {
  it('docks only with a 400px panel, 600px page reserve and unchanged 8px divider', () => {
    expect(dockLayout(1008, DOCK.defaultWidth)).toEqual({ docked: true, width: 400, min: 400, max: 400 });
    for (const available of [1007, 390, 412, 320, Number.NaN]) expect(dockLayout(available, DOCK.defaultWidth).docked).toBe(false);
  });
  it('defaults to560 and clamps old or invalid preferences without exceeding760 or the page reserve', () => {
    expect(dockLayout(1600, DOCK.defaultWidth)).toEqual({ docked: true, width: 560, min: 400, max: 760 });
    expect(dockLayout(1600, 384).width).toBe(400);
    expect(dockLayout(1600, 900).width).toBe(760);
    expect(dockLayout(1600, Number.NaN).width).toBe(560);
    expect(dockLayout(1100, 560)).toEqual({ docked: true, width: 492, min: 400, max: 492 });
  });

  it('keys: Left widens, Right narrows, Shift for 64, Home and End to the bounds', () => {
    expect(keyResize(560, 'Home', false, DOCK.minWidth, DOCK.maxWidth)).toBe(400);
    expect(keyResize(560, 'End', false, DOCK.minWidth, DOCK.maxWidth)).toBe(760);
    expect(keyResize(750, 'ArrowLeft', true, DOCK.minWidth, DOCK.maxWidth)).toBe(760);
    expect(keyResize(384, 'ArrowLeft', false, 320, 560)).toBe(400);
    expect(keyResize(384, 'ArrowRight', false, 320, 560)).toBe(368);
    expect(keyResize(384, 'ArrowLeft', true, 320, 560)).toBe(448);
    expect(keyResize(330, 'ArrowRight', true, 320, 560)).toBe(320);
    expect(keyResize(550, 'ArrowLeft', false, 320, 560)).toBe(560);
    expect(keyResize(384, 'Home', false, 320, 560)).toBe(320);
    expect(keyResize(384, 'End', false, 320, 560)).toBe(560);
    expect(keyResize(384, 'Enter', false, 320, 560)).toBeNull();
  });

  it('dragging the left edge left widens the panel, within bounds', () => {
    expect(dragResize(384, 1000, 950, 320, 560)).toBe(434);
    expect(dragResize(384, 1000, 1100, 320, 560)).toBe(320);
    expect(dragResize(384, 1000, 500, 320, 560)).toBe(560);
  });
});

describe('Iris dock scrollbar allowance', () => {
  it('measures the classic scrollbar once and reports 0 for overlay scrollbars', async () => {
    const make = (offset: number, client: number) => {
      const probe = { style: { cssText: '' }, offsetWidth: offset, clientWidth: client, remove: vi.fn() };
      const appendChild = vi.fn();
      vi.stubGlobal('document', { createElement: () => probe, body: { appendChild } });
      return appendChild;
    };
    vi.resetModules();
    let appended = make(100, 85);
    let dock = await import('./irisDock');
    expect(dock.scrollbarAllowance()).toBe(15);
    expect(dock.scrollbarAllowance()).toBe(15);
    expect(appended).toHaveBeenCalledTimes(1);
    vi.resetModules();
    appended = make(100, 100);
    dock = await import('./irisDock');
    expect(dock.scrollbarAllowance()).toBe(0);
    vi.unstubAllGlobals();
    // 600 + 8 + 400 fits only once the 15px scrollbar is also reserved.
    expect(dockLayout(1015 - 15, DOCK.defaultWidth).docked).toBe(false);
    expect(dockLayout(1023 - 15, DOCK.defaultWidth).docked).toBe(true);
  });
});
