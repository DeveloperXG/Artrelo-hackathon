import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import contractJson from '../../contracts/iris.v2.json';
import fixtures from '../../contracts/iris.v2.fixtures.json';
import { createIrisContract } from '../../contracts/irisContract';
import type { TurnView } from '../../types/irisV2';

const iris = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./IrisProvider', () => ({ useIris: () => iris.value }));

const { IrisController, ACCOUNT_CONTEXT_LABEL } = await import('./irisController');
const { IrisAnswer } = await import('./IrisBlocks');
const { IrisPolicyCard } = await import('./IrisPolicyCard');
const { IrisTranscript } = await import('./IrisTranscript');
const { ERROR_COPY, NOTICE_TITLES, confirmFailureCopy } = await import('./irisCopy');
const { ROUTE_PATHS, NOTICE_ROUTES, evidenceHref, keepsPanelOpen } = await import('./irisRoutes');
const { formatMinorCAD, shouldSubmit } = await import('./irisFormat');

const F = fixtures as unknown as Record<string, TurnView> & { applied: TurnView['preview'] };
const defs = contractJson.$defs as Record<string, { enum?: string[]; oneOf?: { properties: Record<string, { const?: string }> }[]; properties?: Record<string, { enum?: string[] }> }>;
const TOKEN = F.preview.confirmationToken!;

function fakeIris(overrides: Record<string, unknown> = {}) {
  const base = new IrisController({} as never).getState();
  const state = { ...base, ...overrides };
  iris.value = {
    state,
    controller: {
      canConfirm: (id: string) => state.livePreviewIds.includes(id),
      canSend: () => true,
      evidence: async () => null,
      impactPage: async () => null,
    },
    follow: () => {},
  };
  return state;
}

const html = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe('closed enums have exactly one UI mapping', () => {
  it('copy for every contract error code, and nothing else', () => {
    expect(Object.keys(ERROR_COPY).sort()).toEqual([...defs.ErrorCode.enum!].sort());
    expect(Object.keys(contractJson.errors).sort()).toEqual([...defs.ErrorCode.enum!].sort());
  });
  it('a title for every notice code', () => {
    expect(Object.keys(NOTICE_TITLES).sort()).toEqual([...defs.NoticeBlock.properties!.code.enum!].sort());
  });
  it('a literal path for every Route, and the frozen notice routes', () => {
    expect(Object.keys(ROUTE_PATHS).sort()).toEqual([...defs.Route.enum!].sort());
    expect(NOTICE_ROUTES).toEqual(contractJson.navigation.noticeRoutes);
  });
  it('the account context label is the frozen constant', () => {
    expect(defs.Origin.oneOf![0].properties.contextLabel.const).toBe(ACCOUNT_CONTEXT_LABEL);
  });
  it('View Policy keeps the panel open; Open Requests closes it', () => {
    expect(contractJson.navigation).toMatchObject({ viewPolicy: 'keep_panel_open', openRequests: 'close_panel' });
    expect(keepsPanelOpen('/dashboard/policy')).toBe(true);
    expect(keepsPanelOpen('/dashboard/requests')).toBe(false);
    expect(keepsPanelOpen('/dashboard/requests/6ae2bfbed3d03df77beb5eee?tab=activity')).toBe(true);
  });
  it('a preview that would change a read-only setting is rejected at the contract boundary', () => {
    const contract = createIrisContract(contractJson);
    const preview = F.preview.preview!;
    expect(contract.errorsFor('PolicyChangeView', preview)).toEqual([]);
    for (const field of ['autoAdvanceOnVendorDecline', 'maxOutreachAttempts']) {
      const forged = { ...preview, changes: [{ ...preview.changes[0], field }] };
      expect(contract.errorsFor('PolicyChangeView', forged).length, field).toBeGreaterThan(0);
    }
  });
  it('builds links only from closed route kinds', () => {
    const e = F.history.answer!.evidence[0];
    expect(evidenceHref(e)).toBe('/dashboard/requests/6ae2bfbed3d03df77beb5eee?tab=activity');
    expect(evidenceHref({ ...e, requestId: '../../admin' })).toBeNull();
    expect(evidenceHref({ ...e, routeKind: 'none' })).toBeNull();
    expect(evidenceHref(F.help.answer!.evidence[0])).toBe('/dashboard/policy');
  });
});

describe('rendering canonical blocks', () => {
  it('shows the itemized comparison exactly as the server formatted it', () => {
    fakeIris();
    const out = html(<IrisAnswer answer={F.history.answer!} historicalLabel={null} onChoose={null} />);
    for (const text of ['CAD177.49', 'CAD240.00', 'CAD62.51', 'Original quote and final charges', 'Difference']) {
      expect(out).toContain(text);
    }
    expect(out).toContain('Your records');
    expect(out).toContain('Prepared answer from your records (no AI)');
  });

  it('keeps the product guide and your records as separate, labelled sources', () => {
    fakeIris();
    const out = html(<IrisAnswer answer={F.help.answer!} historicalLabel={null} onChoose={null} />);
    expect(out).toContain('>Product guide<');
    expect(out).toContain('>Your records<');
    expect(out).toContain('Source: Auto-contact next vendor');
    expect(out).toContain('Source: Your saved Policy revision 4');
  });

  it('a read-only setting request links to the Policy page and offers no change', () => {
    fakeIris();
    const out = html(<IrisAnswer answer={F.readonlyRefusal.answer!} historicalLabel={null} onChoose={null} />);
    expect(out).toContain('Read-only setting');
    expect(out).toContain('href="/dashboard/policy"');
    expect(out).not.toContain('Confirm');
  });

  it('never renders server text as markup', () => {
    fakeIris();
    const answer = { ...F.help.answer!, blocks: [{ ...F.help.answer!.blocks[0], text: '<img src=x onerror=alert(1)>' }] };
    const out = html(<IrisAnswer answer={answer as never} historicalLabel={null} onChoose={null} />);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});

describe('policy change card', () => {
  const preview = F.preview.preview!;
  const fresh = { ...preview, expiresAt: '2999-01-01T00:00:00.000Z' };

  it('offers Confirm only while the token is held for the current context', () => {
    fakeIris({ livePreviewIds: [preview.id] });
    const live = html(<IrisPolicyCard preview={fresh} inertReason={null} />);
    expect(live).toContain('data-testid="iris-confirm"');
    for (const text of ['CAD300.00', 'CAD250.00', 'Built on saved policy revision 4', 'Your whole account']) expect(live).toContain(text);
    expect(live).not.toContain(TOKEN);

    fakeIris({ livePreviewIds: [] });
    const inert = html(<IrisPolicyCard preview={fresh} inertReason="This preview belongs to an earlier page and is no longer active. No change was applied." />);
    expect(inert).not.toContain('data-testid="iris-confirm"');
    expect(inert).toContain('No change was applied.');
  });

  it('an expired preview cannot be confirmed even with a token', () => {
    fakeIris({ livePreviewIds: [preview.id] });
    const out = html(<IrisPolicyCard preview={{ ...preview, expiresAt: '2000-01-01T00:00:00.000Z' }} inertReason={null} />);
    expect(out).not.toContain('data-testid="iris-confirm"');
    expect(out).toContain('This preview expired. No change was applied.');
  });

  it('an unknown outcome says it is checking and will not send again', () => {
    fakeIris({
      livePreviewIds: [],
      pendingConfirms: [{ previewId: preview.id, clientActionId: 'a', phase: 'unknown', view: null, failure: { kind: 'transport' }, statusStalled: true }],
    });
    const out = html(<IrisPolicyCard preview={fresh} inertReason={null} />);
    expect(out).toContain('It will not send the change again.');
    expect(out).toContain('Check status again');
    expect(out).not.toContain('data-testid="iris-confirm"');
  });

  it('shows the verified receipt, revision and separate refresh status', () => {
    const applied = { ...(fixtures as unknown as { applied: typeof preview }).applied };
    fakeIris({
      policyChanges: { [preview.id]: applied },
      pendingConfirms: [{ previewId: preview.id, clientActionId: 'a', phase: 'settled', view: applied, failure: null, statusStalled: false }],
    });
    const out = html(<IrisPolicyCard preview={fresh} inertReason={null} />);
    expect(out).toContain('Policy change receipt');
    expect(out).toContain(`Saved as policy revision ${applied.appliedRevision}`);
    expect(out).toContain('data-testid="iris-receipt"');
    expect(out).toContain('href="/dashboard/policy"');
  });

  it('a rate-limited confirm says it was not submitted and to wait for a fresh preview', () => {
    const preview = F.preview.preview!;
    const failure = { kind: 'http', status: 429, code: 'rate_limited', retryAfterSeconds: 90, currentPolicyRevision: null, field: null };
    fakeIris({
      livePreviewIds: [],
      policyChanges: { [preview.id]: { ...preview, state: 'discarded' } },
      pendingConfirms: [{ previewId: preview.id, clientActionId: 'a', phase: 'settled', view: null, failure, statusStalled: false }],
    });
    const out = html(<IrisPolicyCard preview={{ ...preview, expiresAt: '2999-01-01T00:00:00.000Z' }} inertReason={null} />);
    expect(out).toContain('this one was not submitted and nothing changed');
    expect(out).toContain('Wait 2 minutes, then ask Iris for a fresh preview.');
    expect(out).not.toContain('data-testid="iris-confirm"');
    expect(confirmFailureCopy({ ...failure, retryAfterSeconds: 30 } as never)).toContain('Wait 30 seconds');
    expect(confirmFailureCopy({ ...failure, retryAfterSeconds: null } as never)).toContain('Wait a few minutes');
  });

  it('the settings table scrolls inside a named, focusable region rather than clipping values', () => {
    fakeIris({ livePreviewIds: [preview.id] });
    const out = html(<IrisPolicyCard preview={fresh} inertReason={null} />);
    const region = out.match(/<div[^>]*data-testid="iris-policy-table"[^>]*>/)?.[0] ?? '';
    expect(region).toContain('role="region"');
    expect(region).toContain('aria-label="Policy settings changed"');
    expect(region).toContain('tabindex="0"');
    expect(region).toContain('overflow-x-auto');
    expect(region).toContain('focus-visible:outline-ring');
    expect(out.indexOf('data-testid="iris-policy-table"')).toBeLessThan(out.indexOf('<table'));
    for (const header of ['>Setting<', '>Now<', '>Proposed<', 'scope="row"']) expect(out).toContain(header);
  });

  it('audit failure says nothing was changed, never "applied without audit"', () => {
    expect(ERROR_COPY.audit_unavailable).toMatch(/not changed/);
    expect(Object.values(ERROR_COPY).join(' ')).not.toMatch(/audit not recorded/i);
  });
});

describe('transcript segments', () => {
  it('labels each segment with its own server label and keeps older answers inert', () => {
    const request = { ...F.history.origin };
    const account = { ...F.preview.origin };
    const state = fakeIris({
      generation: 1,
      context: { status: 'resolved', origin: account, failure: null },
      livePreviewIds: [],
      segments: [
        { key: request.segmentId, origin: request, generation: 0, items: [{ key: 'k1', text: 'Compare the quote', generation: 0, turnId: 't1', phase: 'done', stoppedBy: null, view: { ...F.history, confirmationToken: null }, failure: null }] },
        { key: account.segmentId, origin: account, generation: 1, items: [{ key: 'k2', text: 'Stopped one', generation: 0, turnId: 't2', phase: 'stopped', stoppedBy: 'context', view: null, failure: null }] },
      ],
    });
    const out = html(<IrisTranscript state={state as never} />);
    expect(out).toContain('Asking about: <span class="font-medium text-ink">Synthetic maintenance request</span>');
    expect(out).toContain('Now asking about: <span class="font-medium text-ink">Your account policy</span>');
    expect(out).toContain('Stopped when you moved to another page. This turn did not apply a policy change.');
    expect(out).toContain('role="log"');
    // A long label wraps between the hairlines instead of overflowing a narrow sheet.
    expect(out).toContain('<span class="min-w-0 text-center [overflow-wrap:anywhere]">Asking about');
    expect(out).not.toContain('shrink-0');
    expect(out).toContain('<span class="h-px min-w-4 flex-1 bg-lichen" aria-hidden="true"></span>');
  });
});

describe('composer and formatting', () => {
  it('Enter sends, Shift+Enter is a new line, IME composition never sends', () => {
    expect(shouldSubmit({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(shouldSubmit({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldSubmit({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmit({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
    expect(shouldSubmit({ key: 'a', shiftKey: false })).toBe(false);
  });
  it('formats verified integer cents without floating point', () => {
    expect(formatMinorCAD(25000)).toBe('CAD 250.00');
    expect(formatMinorCAD(17749)).toBe('CAD 177.49');
    expect(formatMinorCAD(5)).toBe('CAD 0.05');
    expect(formatMinorCAD(123456789)).toBe('CAD 1,234,567.89');
    expect(formatMinorCAD(null)).toBe('Not set');
    expect(formatMinorCAD(1.5)).toBe('Unavailable');
  });
});
