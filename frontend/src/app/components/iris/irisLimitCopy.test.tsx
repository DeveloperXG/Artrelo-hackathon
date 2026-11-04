import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const iris = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./IrisProvider', () => ({ useIris: () => iris.value }));

const { IrisController } = await import('./irisController');
const { IrisPanel } = await import('./IrisPanel');

function render(limit: 'conversation_limit' | 'turn_limit') {
  const state = { ...new IrisController({} as never).getState(), open: true, limit };
  iris.value = {
    state,
    dock: { docked: true, width: 384, min: 320, max: 560 },
    setPanelWidth: () => {},
    mainRef: { current: null },
    draft: { current: '', epoch: state.draftEpoch },
    openPanel: () => {},
    closePanel: () => {},
    takeCloseFocus: () => 'launcher',
    follow: () => {},
    controller: { canSend: () => false, newConversation: async () => {} },
  };
  return renderToStaticMarkup(<MemoryRouter>{<IrisPanel />}</MemoryRouter>);
}

describe('Iris conversation limits', () => {
  it('states the two-conversation profile cap and its expiry, without blaming another tab', () => {
    const out = render('conversation_limit');
    expect(out).toContain('two conversations open for your account');
    expect(out).toContain('30 minutes');
    expect(out).not.toMatch(/another tab/i);
    // Nothing on this page can free a slot it never held: the action only asks again.
    expect(out).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(out).not.toContain('Start a new conversation');
  });

  it('keeps Start a new conversation for limits this conversation itself reached', () => {
    expect(render('turn_limit')).toMatch(/<button[^>]*>Start a new conversation<\/button>/);
  });
});
