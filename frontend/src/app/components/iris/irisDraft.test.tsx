import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const iris = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./IrisProvider', () => ({ useIris: () => iris.value }));

const { IrisController } = await import('./irisController');
const { IrisPanel } = await import('./IrisPanel');

function fakeIris(draft: { current: string; epoch: number }) {
  const state = { ...new IrisController({} as never).getState(), open: true };
  iris.value = {
    state,
    dock: { docked: true, width: 384, min: 320, max: 560 },
    setPanelWidth: () => {},
    mainRef: { current: null },
    draft,
    openPanel: () => {},
    closePanel: () => {},
    takeCloseFocus: () => 'launcher',
    follow: () => {},
    controller: { canSend: () => true, newConversation: async () => {} },
  };
  return state.draftEpoch;
}

const html = () => renderToStaticMarkup(<MemoryRouter>{<IrisPanel />}</MemoryRouter>);
const NOTICE = 'Your unsent message was cleared because you moved to another page.';

describe('Iris unsent draft scope', () => {
  it('keeps a draft typed in the same context (close and reopen, dock and sheet swaps)', () => {
    const epoch = new IrisController({} as never).getState().draftEpoch;
    fakeIris({ current: 'Is autopilot on?', epoch });
    const out = html();
    expect(out).toMatch(/<textarea[^>]*>Is autopilot on\?<\/textarea>/);
    expect(out).not.toContain(NOTICE);
  });

  it('discards a draft typed in another context while the panel was closed, and says so', () => {
    const epoch = new IrisController({} as never).getState().draftEpoch;
    fakeIris({ current: 'About request A', epoch: epoch - 1 });
    const out = html();
    expect(out).not.toContain('About request A');
    expect(out).toContain(NOTICE);
  });

  it('shows no notice when the stale draft was empty', () => {
    const epoch = new IrisController({} as never).getState().draftEpoch;
    fakeIris({ current: '   ', epoch: epoch + 1 });
    expect(html()).not.toContain(NOTICE);
  });
});
