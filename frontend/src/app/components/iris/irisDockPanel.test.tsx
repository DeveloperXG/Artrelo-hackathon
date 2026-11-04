import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const iris = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./IrisProvider', () => ({ useIris: () => iris.value }));

const { IrisController } = await import('./irisController');
const { IrisPanel } = await import('./IrisPanel');

function fakeIris(dock: { docked: boolean; width: number; min: number; max: number }) {
  const state = { ...new IrisController({} as never).getState(), open: true };
  iris.value = {
    state,
    dock,
    setPanelWidth: () => {},
    mainRef: { current: null },
    draft: { current: '' },
    openPanel: () => {},
    closePanel: () => {},
    takeCloseFocus: () => 'launcher',
    follow: () => {},
    controller: { canSend: () => true, newConversation: async () => {} },
  };
}

const html = () => renderToStaticMarkup(<MemoryRouter>{<IrisPanel />}</MemoryRouter>);

describe('Docked Iris panel', () => {
  it('is a non-modal side panel with a labelled, keyboard-focusable vertical separator', () => {
    fakeIris({ docked: true, width: 560, min: 400, max: 760 });
    const out = html();
    expect(out).toContain('data-iris-mode="docked"');
    expect(out).toMatch(/<aside[^>]*aria-labelledby="iris-docked-title"/);
    expect(out).toContain('width:568px');
    // No backdrop and nothing modal.
    expect(out).not.toContain('bg-black/40');
    expect(out).not.toContain('aria-modal');
    expect(out).not.toContain('role="dialog"');
    const separator = out.match(/<div role="separator"[^>]*>/)?.[0] ?? '';
    expect(separator).toContain('aria-orientation="vertical"');
    expect(separator).toContain('aria-label="Resize Ask Iris"');
    expect(separator).toContain('aria-valuemin="400"');
    expect(separator).toContain('aria-valuemax="760"');
    expect(separator).toContain('aria-valuenow="560"');
    expect(separator).toContain('tabindex="0"');
  });

  it('offers 24px Wider and Narrower buttons as the single-pointer alternative, disabled at the bounds', () => {
    fakeIris({ docked: true, width: 560, min: 400, max: 760 });
    const out = html();
    for (const name of ['Make Ask Iris wider', 'Make Ask Iris narrower', 'Close Iris']) {
      const button = out.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`))?.[0] ?? '';
      expect(button, name).toContain('size-6');
      expect(button, name).not.toContain('disabled=""');
    }
    fakeIris({ docked: true, width: 760, min: 400, max: 760 });
    expect(html()).toMatch(/<button[^>]*aria-label="Make Ask Iris wider"[^>]*disabled=""/);
    fakeIris({ docked: true, width: 400, min: 400, max: 760 });
    expect(html()).toMatch(/<button[^>]*aria-label="Make Ask Iris narrower"[^>]*disabled=""/);
  });

  it('wraps the header actions instead of squeezing the title at narrow widths or large text', () => {
    fakeIris({ docked: true, width: 400, min: 400, max: 760 });
    const out = html();
    expect(out).toMatch(/<header class="[^"]*flex-wrap/);
    expect(out).toMatch(/<div class="[^"]*min-w-0 flex-1 basis-32/);
    expect(out).toMatch(/<div class="ml-auto flex min-w-0 max-w-full flex-wrap/);
  });

  it('falls back to the modal sheet when the page cannot keep its width', () => {
    fakeIris({ docked: false, width: 560, min: 400, max: 760 });
    const out = html();
    expect(out).not.toContain('data-iris-mode="docked"');
    expect(out).not.toContain('role="separator"');
  });
});
