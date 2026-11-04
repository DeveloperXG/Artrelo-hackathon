import { describe, expect, it } from 'vitest';
import fixtures from '../../contracts/iris.v2.fixtures.json';
import type { Origin, PolicyChangeView, TurnView } from '../../types/irisV2';
import { IrisCallError, type IrisApi, type IrisFailure } from './irisApi';
import { IrisController, type Scheduler } from './irisController';

const F = fixtures as unknown as {
  conversation: { conversationId: string };
  preview: TurnView;
  help: TurnView;
  history: TurnView;
  readonlyRefusal: TurnView;
  trimmed: TurnView;
  applied: PolicyChangeView;
};

const REQ_A = '6ae2bfbed3d03df77beb5eee';
const REQ_B = '6ae2bfbed3d03df77beb5eef';
const TOKEN = F.preview.confirmationToken!;

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const http = (code: string, status: number, retryAfterSeconds: number | null = null): IrisCallError =>
  new IrisCallError({ kind: 'http', status, code, retryAfterSeconds, currentPolicyRevision: null, field: null } as IrisFailure);

function originFor(requestContextId: string | null, generation: number): Origin {
  return requestContextId
    ? { segmentId: `seg_${requestContextId.slice(-3)}_${generation}`, contextGeneration: generation, requestContextId, contextKind: 'request', contextLabel: `Request ${requestContextId.slice(-3)}` }
    : { segmentId: `seg_account_${generation}`, contextGeneration: generation, requestContextId: null, contextKind: 'account', contextLabel: 'Your account policy' };
}

function turnFor(base: TurnView, origin: Origin, turnId: string): TurnView {
  const view = clone(base);
  view.origin = origin;
  view.turnId = turnId;
  if (view.preview) view.preview.origin = origin;
  return view;
}

class ManualScheduler implements Scheduler {
  queue: { fn: () => void; handle: number }[] = [];
  private next = 1;
  setTimeout(fn: () => void) {
    const handle = this.next++;
    this.queue.push({ fn, handle });
    return handle;
  }
  clearTimeout(handle: unknown) {
    this.queue = this.queue.filter((t) => t.handle !== handle);
  }
  async tick() {
    const due = this.queue;
    this.queue = [];
    for (const t of due) t.fn();
    await flush();
  }
}

type Calls = { name: string; args: unknown[] }[];

function harness(overrides: Partial<IrisApi> = {}) {
  const calls: Calls = [];
  const turnViews = new Map<string, TurnView[]>();
  let ids = 0;
  const log = (name: string, args: unknown[]) => calls.push({ name, args: clone(args) });
  const api: IrisApi = {
    createConversation: async (...args) => (log('createConversation', args), clone(F.conversation) as never),
    resolveContext: async (_id, body) => (log('resolveContext', [body]), originFor(body.requestContextId, body.contextGeneration)),
    closeConversation: async (id) => (log('closeConversation', [id]), { conversationId: id, status: 'closed', serverTime: '2026-10-29T18:00:00.000Z' }),
    closeOnPagehide: async (id) => (log('closeOnPagehide', [id]), { conversationId: id, status: 'closed', serverTime: '2026-10-29T18:00:00.000Z' }),
    postTurn: async (_id, body) => {
      log('postTurn', [body]);
      return { turnId: `turn_${body.clientTurnId}`, status: 'accepted', origin: originFor(body.requestContextId, body.contextGeneration), serverTime: '2026-10-29T18:00:00.000Z' };
    },
    getTurn: async (turnId) => {
      log('getTurn', [turnId]);
      const queue = turnViews.get(turnId) ?? [];
      const view = queue.length > 1 ? queue.shift()! : queue[0];
      if (!view) throw http('record_not_found', 404);
      return clone(view);
    },
    cancelTurn: async (turnId) => (log('cancelTurn', [turnId]), { turnId, status: 'cancelled', serverTime: '2026-10-29T18:00:00.000Z' }),
    getPolicyChange: async (id) => (log('getPolicyChange', [id]), clone(F.applied)),
    getImpact: async () => {
      throw new Error('not used');
    },
    confirm: async (id, body) => (log('confirm', [id, body]), clone(F.applied)),
    discard: async (id) => (log('discard', [id]), { ...clone(F.applied), state: 'discarded', appliedRevision: null }),
    getEvidence: async () => {
      throw new Error('not used');
    },
    ...overrides,
  };
  const scheduler = new ManualScheduler();
  const session = { signedIn: true };
  const controller = new IrisController(api, {
    scheduler,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    isSignedIn: () => session.signedIn,
  });
  const respond = (clientTurnIdIndex: number, ...views: TurnView[]) => {
    const turnId = `turn_00000000-0000-4000-8000-${String(clientTurnIdIndex).padStart(12, '0')}`;
    turnViews.set(turnId, views.map((v) => ({ ...v, turnId })));
    return turnId;
  };
  const named = (name: string) => calls.filter((c) => c.name === name);
  return { controller, calls, named, scheduler, respond, session };
}

async function openOn(h: ReturnType<typeof harness>, requestId: string | null) {
  h.controller.setRoute(requestId);
  await h.controller.open();
  await flush();
}

describe('IrisController: context and segments', () => {
  it('opens with one conversation and a server-resolved, labelled segment', async () => {
    const h = harness();
    await openOn(h, REQ_A);
    const s = h.controller.getState();
    expect(h.named('createConversation')).toHaveLength(1);
    expect(h.named('resolveContext')[0].args[0]).toEqual({ requestContextId: REQ_A, contextGeneration: 0 });
    expect(s.context.status).toBe('resolved');
    expect(s.segments.map((x) => x.origin.contextLabel)).toEqual(['Request eee']);
  });

  it('keeps one conversation and every earlier message across request -> account -> request', async () => {
    const h = harness();
    await openOn(h, REQ_A);
    h.respond(2, turnFor(F.history, originFor(REQ_A, 0), 'x'));
    await h.controller.send('Compare the quote with the final charges');
    await h.scheduler.tick();
    h.controller.setRoute(null);
    await flush();
    h.controller.setRoute(REQ_B);
    await flush();
    const s = h.controller.getState();
    expect(h.named('createConversation')).toHaveLength(1);
    expect(h.named('resolveContext').map((c) => c.args[0])).toEqual([
      { requestContextId: REQ_A, contextGeneration: 0 },
      { requestContextId: null, contextGeneration: 1 },
      { requestContextId: REQ_B, contextGeneration: 2 },
    ]);
    // The empty account divider is dropped; A's answer keeps A's label.
    expect(s.segments.map((x) => x.origin.contextLabel)).toEqual(['Request eee', 'Request eef']);
    expect(s.segments[0].items[0].view?.answer?.blocks[0].kind).toBe('cost_table');
    expect(s.draftEpoch).toBe(2);
  });

  it('A -> account -> A with a reused segmentId still starts a new, current segment for the return', async () => {
    // The contract does not promise a fresh segmentId per generation.
    const h = harness({
      resolveContext: async (_id, body) => ({ ...originFor(body.requestContextId, body.contextGeneration), segmentId: body.requestContextId ? 'seg_A' : 'seg_acct' }),
    });
    await openOn(h, REQ_A);
    h.respond(2, turnFor(F.history, { ...originFor(REQ_A, 0), segmentId: 'seg_A' }, 'x'));
    await h.controller.send('Compare the quote with the final charges');
    await h.scheduler.tick();
    h.controller.setRoute(null);
    await flush();
    h.controller.setRoute(REQ_A);
    await flush();
    await h.controller.send('What did I ask earlier?');
    const s = h.controller.getState();
    expect(s.segments.map((x) => [x.key, x.generation, x.items.length])).toEqual([
      ['seg_A', 0, 1],
      ['seg_A', 2, 1],
    ]);
    expect(s.segments[1].items[0]).toMatchObject({ text: 'What did I ask earlier?', generation: 2 });
    expect(h.named('postTurn').at(-1)!.args[0]).toMatchObject({ requestContextId: REQ_A, contextGeneration: 2 });
  });

  it('ignores query/tab changes on the same request', async () => {
    const h = harness();
    await openOn(h, REQ_A);
    h.controller.setRoute(REQ_A);
    expect(h.controller.getState().generation).toBe(0);
    expect(h.named('resolveContext')).toHaveLength(1);
  });

  it('never calls the server for a malformed route id, and shows no context', async () => {
    const h = harness();
    await openOn(h, 'not-a-request');
    expect(h.named('resolveContext')).toHaveLength(0);
    expect(h.controller.getState().context.status).toBe('unavailable');
    expect(h.controller.canSend()).toBe(false);
  });

  it('treats a foreign or deleted request as unavailable with no account fallback', async () => {
    const h = harness({
      resolveContext: async () => {
        throw http('record_not_found', 404);
      },
    });
    await openOn(h, REQ_A);
    const s = h.controller.getState();
    expect(s.context.status).toBe('unavailable');
    expect(s.segments).toEqual([]);
    expect(h.controller.canSend()).toBe(false);
  });

  it('makes no call at all before the panel is opened', async () => {
    const h = harness();
    h.controller.setRoute(REQ_A);
    h.controller.setRoute(null);
    await flush();
    expect(h.calls).toEqual([]);
  });
});

describe('IrisController: turns and late results', () => {
  it('posts with an idempotent clientTurnId and the current generation, then polls to completion', async () => {
    const h = harness();
    await openOn(h, REQ_A);
    const reading = { ...turnFor(F.history, originFor(REQ_A, 0), 'x'), status: 'reading' as const, answer: null };
    h.respond(2, reading, turnFor(F.history, originFor(REQ_A, 0), 'x'));
    await h.controller.send('History please');
    expect(h.named('postTurn')[0].args[0]).toEqual({
      clientTurnId: '00000000-0000-4000-8000-000000000002',
      text: 'History please',
      requestContextId: REQ_A,
      contextGeneration: 0,
    });
    await h.scheduler.tick();
    expect(h.controller.getState().segments[0].items[0].phase).toBe('active');
    await h.scheduler.tick();
    expect(h.controller.getState().segments[0].items[0].phase).toBe('done');
    expect(h.scheduler.queue).toHaveLength(0);
  });

  it('stops a pending read on navigation, cancels it, and never shows its late answer', async () => {
    const h = harness();
    await openOn(h, REQ_A);
    const turnId = h.respond(2, turnFor(F.history, originFor(REQ_A, 0), 'x'));
    await h.controller.send('History please');
    h.controller.setRoute(null);
    await flush();
    await h.scheduler.tick();
    const item = h.controller.getState().segments[0].items[0];
    expect(item).toMatchObject({ phase: 'stopped', stoppedBy: 'context', view: null });
    expect(h.named('cancelTurn').map((c) => c.args[0])).toEqual([turnId]);
    expect(h.named('getTurn')).toHaveLength(0);
  });

  it('cancels a turn the server accepts only after the person moved on', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness();
    const post = (h.controller as unknown as { api: IrisApi }).api.postTurn;
    (h.controller as unknown as { api: IrisApi }).api.postTurn = async (...args) => {
      await gate;
      return post(...args);
    };
    await openOn(h, REQ_A);
    const sending = h.controller.send('History please');
    h.controller.setRoute(REQ_B);
    release();
    await sending;
    await flush();
    expect(h.named('cancelTurn')).toHaveLength(1);
    expect(h.named('getTurn')).toHaveLength(0);
  });

  it('stops on request with Stop, and says no policy change was applied by cancelling', async () => {
    const h = harness();
    await openOn(h, REQ_A);
    h.respond(2, { ...turnFor(F.history, originFor(REQ_A, 0), 'x'), status: 'reading', answer: null });
    await h.controller.send('History please');
    h.controller.stop('00000000-0000-4000-8000-000000000002');
    await flush();
    expect(h.controller.getState().segments[0].items[0]).toMatchObject({ phase: 'stopped', stoppedBy: 'person' });
    expect(h.named('cancelTurn')).toHaveLength(1);
  });

  it('re-sends a transport failure with the SAME clientTurnId', async () => {
    let fail = true;
    const h = harness();
    const post = (h.controller as unknown as { api: IrisApi }).api.postTurn;
    (h.controller as unknown as { api: IrisApi }).api.postTurn = async (...args) => {
      if (fail) {
        fail = false;
        throw new IrisCallError({ kind: 'transport' });
      }
      return post(...args);
    };
    await openOn(h, REQ_A);
    await h.controller.send('History please');
    const key = h.controller.getState().segments[0].items[0].key;
    expect(h.controller.getState().segments[0].items[0].phase).toBe('failed');
    await h.controller.retry(key);
    expect(h.named('postTurn')[0].args[0]).toMatchObject({ clientTurnId: key });
  });

  it('removes exactly the trimmed inactive segments and says so', async () => {
    const h = harness();
    await openOn(h, REQ_A);
    h.respond(2, turnFor(F.history, originFor(REQ_A, 0), 'x'));
    await h.controller.send('History please');
    await h.scheduler.tick();
    h.controller.setRoute(null);
    await flush();
    const trimmed = turnFor(F.trimmed, originFor(null, 1), 'y');
    trimmed.trimmedSegmentIds = [originFor(REQ_A, 0).segmentId];
    h.respond(3, trimmed);
    await h.controller.send('What does auto-contact do?');
    await h.scheduler.tick();
    const s = h.controller.getState();
    expect(s.trimmed).toBe(true);
    expect(s.segments.map((x) => x.origin.contextLabel)).toEqual(['Your account policy']);
  });

  it('turns a hard turn cap into an explicit New conversation that closes the old slot', async () => {
    const h = harness({
      postTurn: async () => {
        throw http('turn_limit', 409);
      },
    });
    await openOn(h, null);
    await h.controller.send('One more');
    expect(h.controller.getState().limit).toBe('turn_limit');
    expect(h.controller.canSend()).toBe(false);
    await h.controller.newConversation();
    await flush();
    expect(h.named('closeConversation')).toHaveLength(1);
    expect(h.named('createConversation')).toHaveLength(2);
    expect(h.controller.getState().segments.map((x) => x.items.length)).toEqual([0]);
  });

  it('creates the replacement only after the old conversation has closed (profile cap of two)', async () => {
    let release: () => void = () => {};
    const closes: string[] = [];
    const h = harness({
      closeConversation: (id) =>
        new Promise((resolve) => {
          closes.push(id);
          release = () => resolve({ conversationId: id, status: 'closed', serverTime: '2026-10-29T18:00:00.000Z' });
        }),
    });
    await openOn(h, null);
    const replacing = h.controller.newConversation();
    // A second click while the close is still in flight must wait for it too.
    const again = h.controller.newConversation();
    await flush();
    expect(closes).toHaveLength(1);
    expect(h.named('createConversation')).toHaveLength(1);
    release();
    await Promise.all([replacing, again]);
    await flush();
    expect(closes).toHaveLength(1);
    expect(h.named('createConversation')).toHaveLength(2);
  });

  it('does not fake a closed slot: a failed close still lets the create report its real outcome', async () => {
    let creates = 0;
    const h = harness({
      closeConversation: async () => {
        throw http('service_unavailable', 503);
      },
      createConversation: async () => {
        creates += 1;
        if (creates > 1) throw http('conversation_limit', 429);
        return clone(F.conversation) as never;
      },
    });
    await openOn(h, null);
    await h.controller.newConversation();
    await flush();
    const s = h.controller.getState();
    expect(creates).toBe(2);
    expect(s.conversationId).toBeNull();
    expect(s.limit).toBe('conversation_limit');
  });
});

describe('IrisController: confirmation tokens', () => {
  async function withPreview(h: ReturnType<typeof harness>) {
    await openOn(h, null);
    h.respond(2, turnFor(F.preview, originFor(null, 0), 'p'));
    await h.controller.send('Set my default quota to CAD250');
    await h.scheduler.tick();
    return F.preview.preview!.id;
  }

  it('never puts the token in state, and only a current-context preview is confirmable', async () => {
    const h = harness();
    const id = await withPreview(h);
    const s = h.controller.getState();
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(s.livePreviewIds).toEqual([id]);
    expect(h.controller.canConfirm(id)).toBe(true);
  });

  it('discards an unused preview when the person moves to another context; the card stays, inert', async () => {
    const h = harness();
    const id = await withPreview(h);
    h.controller.setRoute(REQ_A);
    await flush();
    const s = h.controller.getState();
    expect(h.named('discard').map((c) => c.args[0])).toEqual([id]);
    expect(s.livePreviewIds).toEqual([]);
    expect(h.controller.canConfirm(id)).toBe(false);
    expect(s.segments[0].items[0].view?.preview?.id).toBe(id);
    expect(s.policyChanges[id].state).toBe('discarded');
  });

  it('confirms with exactly the bound hashes and revision, then drops the token', async () => {
    const h = harness();
    const id = await withPreview(h);
    await h.controller.confirm(id);
    const [, body] = h.named('confirm')[0].args as [string, Record<string, unknown>];
    expect(body).toMatchObject({
      confirmationToken: TOKEN,
      expectedPolicyRevision: F.preview.preview!.basePolicyRevision,
      patchHash: F.preview.preview!.patchHash,
      impactHash: F.preview.preview!.impactHash,
    });
    const s = h.controller.getState();
    expect(s.pendingConfirms[0]).toMatchObject({ phase: 'settled', view: { state: 'applied' } });
    expect(s.livePreviewIds).toEqual([]);
  });

  it('on an unknown outcome reads status and never posts the confirmation again', async () => {
    const h = harness({
      confirm: async () => {
        throw new IrisCallError({ kind: 'transport' });
      },
    });
    const id = await withPreview(h);
    await h.controller.confirm(id);
    await flush();
    expect(h.named('getPolicyChange').map((c) => c.args[0])).toEqual([id]);
    expect(h.controller.getState().pendingConfirms[0]).toMatchObject({ phase: 'settled', view: { state: 'applied' } });
  });

  it('offers the same action again only after status verifies it was not applied', async () => {
    let confirms = 0;
    const h = harness({
      confirm: async () => {
        confirms += 1;
        throw new IrisCallError({ kind: 'transport' });
      },
      getPolicyChange: async () => clone(F.preview.preview!),
    });
    const id = await withPreview(h);
    await h.controller.confirm(id);
    await flush();
    const pending = h.controller.getState().pendingConfirms[0];
    expect(pending.phase).toBe('not_applied');
    expect(confirms).toBe(1);
    expect(h.controller.canConfirm(id)).toBe(true);
  });

  it('a 429 on confirm was not submitted: no retry, no status read, the unused preview is discarded', async () => {
    let confirms = 0;
    const h = harness({
      confirm: async () => {
        confirms += 1;
        throw http('rate_limited', 429, 90);
      },
    });
    const id = await withPreview(h);
    await h.controller.confirm(id);
    await flush();
    await h.scheduler.tick();
    expect(confirms).toBe(1);
    expect(h.named('getPolicyChange')).toHaveLength(0);
    expect(h.named('discard').map((c) => c.args[0])).toEqual([id]);
    const s = h.controller.getState();
    expect(s.pendingConfirms[0]).toMatchObject({ phase: 'settled', failure: { code: 'rate_limited', retryAfterSeconds: 90 } });
    expect(s.livePreviewIds).toEqual([]);
    expect(h.controller.canConfirm(id)).toBe(false);
    expect(s.policyChanges[id].state).toBe('discarded');
    // Confirming again does nothing: the person asks for a fresh preview.
    await h.controller.confirm(id);
    expect(confirms).toBe(1);
  });

  it('a closed 409 is a known not-applied outcome and the token is dropped', async () => {
    const h = harness({
      confirm: async () => {
        throw http('stale_policy', 409);
      },
    });
    const id = await withPreview(h);
    await h.controller.confirm(id);
    const pending = h.controller.getState().pendingConfirms[0];
    expect(pending.phase).toBe('settled');
    expect(pending.failure).toMatchObject({ kind: 'http', code: 'stale_policy' });
    expect(h.controller.canConfirm(id)).toBe(false);
  });

  it('a 5xx on confirm is an unknown outcome: status is read, the change is never posted again', async () => {
    let confirms = 0;
    const h = harness({
      confirm: async () => {
        confirms += 1;
        throw http('service_unavailable', 503);
      },
    });
    const id = await withPreview(h);
    await h.controller.confirm(id);
    await flush();
    expect(confirms).toBe(1);
    expect(h.named('getPolicyChange').map((c) => c.args[0])).toEqual([id]);
    // Status found it applied: the receipt shows, not "try again".
    expect(h.controller.getState().pendingConfirms[0]).toMatchObject({ phase: 'settled', view: { state: 'applied' }, failure: null });
  });

  it('audit_unavailable is a known rollback: no status read, nothing to confirm again', async () => {
    const h = harness({
      confirm: async () => {
        throw http('audit_unavailable', 503);
      },
    });
    const id = await withPreview(h);
    await h.controller.confirm(id);
    await flush();
    expect(h.named('getPolicyChange')).toHaveLength(0);
    expect(h.controller.getState().pendingConfirms[0]).toMatchObject({ phase: 'settled', failure: { code: 'audit_unavailable' } });
    expect(h.controller.canConfirm(id)).toBe(false);
  });

  it('keeps a submitted confirmation through conversation expiry', async () => {
    const h = harness({
      confirm: async () => {
        throw new IrisCallError({ kind: 'transport' });
      },
      getPolicyChange: async () => {
        throw new IrisCallError({ kind: 'transport' });
      },
    });
    const id = await withPreview(h);
    await h.controller.confirm(id);
    // A later turn hits the TTL.
    (h.controller as unknown as { api: IrisApi }).api.postTurn = async () => {
      throw http('conversation_expired', 410);
    };
    await h.controller.send('anything');
    const s = h.controller.getState();
    expect(s.phase).toBe('expired');
    expect(s.segments).toEqual([]);
    expect(s.pendingConfirms.map((p) => [p.previewId, p.phase])).toEqual([[id, 'unknown']]);
    expect(h.scheduler.queue.length).toBeGreaterThan(0); // status reads continue
  });

  it('a read-only setting request is a refusal with no preview and no token', async () => {
    const h = harness();
    await openOn(h, null);
    h.respond(2, turnFor(F.readonlyRefusal, originFor(null, 0), 'r'));
    await h.controller.send('Turn on auto-contact');
    await h.scheduler.tick();
    const s = h.controller.getState();
    expect(s.segments[0].items[0].view?.answer?.blocks[0]).toMatchObject({ kind: 'notice', code: 'unsupported_setting' });
    expect(s.livePreviewIds).toEqual([]);
  });
});

describe('IrisController: closed panel', () => {
  it('navigating with the panel closed stops the read, cancels it, and resolves nothing until reopened', async () => {
    const h = harness();
    await openOn(h, REQ_A);
    h.respond(2, { ...turnFor(F.history, originFor(REQ_A, 0), 'x'), status: 'reading', answer: null });
    await h.controller.send('Compare the quote');
    h.controller.close();
    const resolvesBefore = h.named('resolveContext').length;
    h.controller.setRoute(REQ_B);
    await flush();
    const s = h.controller.getState();
    expect(s.segments[0].items[0]).toMatchObject({ phase: 'stopped', stoppedBy: 'context' });
    expect(h.named('cancelTurn')).toHaveLength(1);
    expect(h.named('resolveContext')).toHaveLength(resolvesBefore);
    expect(s.context.status).toBe('unresolved');
    // The pending poll finds the turn stopped and makes no read.
    const reads = h.named('getTurn').length;
    await h.scheduler.tick();
    expect(h.named('getTurn')).toHaveLength(reads);
    await h.controller.open();
    await flush();
    expect(h.named('resolveContext').at(-1)!.args[0]).toEqual({ requestContextId: REQ_B, contextGeneration: 1 });
  });
});

describe('IrisController: auth loss', () => {
  it('a session that ends between polls stops polling with no further call', async () => {
    const h = harness();
    await openOn(h, null);
    h.respond(2, { ...turnFor(F.help, originFor(null, 0), 'h'), status: 'reading', answer: null });
    await h.controller.send('What does auto-contact do?');
    await h.scheduler.tick(); // one read: still reading
    const before = h.calls.length;
    h.session.signedIn = false;
    await h.scheduler.tick();
    expect(h.calls.length).toBe(before);
    expect(h.controller.getState().phase).toBe('signed_out');
    expect(h.scheduler.queue).toHaveLength(0);
  });

  it('clears everything synchronously and makes no further call', async () => {
    const h = harness({
      confirm: async () => {
        throw new IrisCallError({ kind: 'transport' });
      },
      getPolicyChange: async () => {
        throw new IrisCallError({ kind: 'transport' });
      },
    });
    await openOn(h, null);
    h.respond(2, turnFor(F.preview, originFor(null, 0), 'p'));
    await h.controller.send('Set my default quota to CAD250');
    await h.scheduler.tick();
    await h.controller.confirm(F.preview.preview!.id);
    await flush();
    h.controller.signOut();
    const s = h.controller.getState();
    expect(s.phase).toBe('signed_out');
    expect(s.segments).toEqual([]);
    expect(s.pendingConfirms).toEqual([]);
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(h.scheduler.queue).toHaveLength(0);
    const before = h.calls.length;
    await h.controller.open();
    h.controller.setRoute(REQ_A);
    await h.controller.send('anything');
    await flush();
    expect(h.calls.length).toBe(before);
  });
});

describe('IrisController: pagehide close', () => {
  const ID = F.conversation.conversationId;

  it("closes only this tab's own conversation, once, as an unload keepalive", async () => {
    const h = harness();
    await openOn(h, null);
    h.controller.pagehide();
    h.controller.pagehide();
    expect(h.named('closeOnPagehide').map((c) => c.args[0])).toEqual([ID]);
    // The ordinary close is not used, and nothing else is called on the way out.
    expect(h.named('closeConversation')).toHaveLength(0);
    expect(h.calls.at(-1)?.name).toBe('closeOnPagehide');
  });

  it('sends nothing without a known id: before any conversation, or while one is still being created', async () => {
    const idle = harness();
    idle.controller.pagehide();
    expect(idle.calls).toHaveLength(0);

    const starting = harness({ createConversation: () => new Promise(() => {}) });
    starting.controller.setRoute(null);
    void starting.controller.open();
    await flush();
    starting.controller.pagehide();
    expect(starting.named('closeOnPagehide')).toHaveLength(0);
  });

  it('sends nothing after auth loss: another identity in the stored session, or sign-out', async () => {
    const other = harness();
    await openOn(other, null);
    other.session.signedIn = false;
    other.controller.pagehide();
    expect(other.named('closeOnPagehide')).toHaveLength(0);

    const out = harness();
    await openOn(out, null);
    out.controller.signOut();
    out.controller.pagehide();
    expect(out.named('closeOnPagehide')).toHaveLength(0);
  });

  it('a pending confirm is never re-sent; its status reconciliation continues after the close', async () => {
    // The outcome stays unknown until the page is going away; the next status
    // read after the close then finds the durable receipt.
    let reachable = false;
    let statusReads = 0;
    let confirms = 0;
    const h = harness({
      confirm: async () => {
        confirms += 1;
        throw new IrisCallError({ kind: 'transport' });
      },
      getPolicyChange: async () => {
        statusReads += 1;
        if (!reachable) throw new IrisCallError({ kind: 'transport' });
        return clone(F.applied);
      },
    });
    await openOn(h, null);
    h.respond(2, turnFor(F.preview, originFor(null, 0), 'p'));
    await h.controller.send('Set my default quota to CAD250');
    await h.scheduler.tick();
    await h.controller.confirm(F.preview.preview!.id);
    await flush();
    expect(h.controller.getState().pendingConfirms[0].phase).toBe('unknown');

    h.controller.pagehide();
    expect(h.named('closeOnPagehide')).toHaveLength(1);
    const readsBefore = statusReads;
    reachable = true;
    await h.scheduler.tick();
    await flush();
    expect(confirms).toBe(1);
    expect(statusReads).toBeGreaterThan(readsBefore);
    expect(h.controller.getState().pendingConfirms[0]).toMatchObject({ phase: 'settled', view: { state: 'applied' } });
  });

  it('a failed keepalive is not retried and changes nothing on the page', async () => {
    let attempts = 0;
    const h = harness({
      closeOnPagehide: async () => {
        attempts += 1;
        throw new IrisCallError({ kind: 'transport' });
      },
    });
    await openOn(h, null);
    const before = h.controller.getState();
    h.controller.pagehide();
    await flush();
    h.controller.pagehide();
    expect(attempts).toBe(1);
    expect(h.controller.getState()).toBe(before);
  });

  it('during New conversation it sends nothing for the old id; afterwards it closes only the replacement', async () => {
    let created = 0;
    let finishClose: () => void = () => {};
    const h = harness({
      createConversation: async () => ({ ...clone(F.conversation), conversationId: `conv_${++created}` }) as never,
      closeConversation: (id) =>
        new Promise((resolve) => {
          finishClose = () => resolve({ conversationId: id, status: 'closed', serverTime: '2026-10-29T18:00:00.000Z' });
        }),
    });
    await openOn(h, null);
    const replacing = h.controller.newConversation();
    await flush();
    h.controller.pagehide(); // the old id is being closed normally; there is no new id yet
    expect(h.named('closeOnPagehide')).toHaveLength(0);
    finishClose();
    await replacing;
    await flush();
    h.controller.pagehide();
    expect(h.named('closeOnPagehide').map((c) => c.args[0])).toEqual(['conv_2']);
  });

  it('restored from the back/forward cache, the closed conversation reads as expired', async () => {
    const h = harness();
    await openOn(h, null);
    h.controller.pageshow(true); // no close was sent: nothing to change
    expect(h.controller.getState().conversationId).toBe(ID);
    h.controller.pagehide();
    h.controller.pageshow(false); // a normal load: not a restore
    expect(h.controller.getState().conversationId).toBe(ID);
    h.controller.pageshow(true);
    expect(h.controller.getState()).toMatchObject({ phase: 'expired', conversationId: null });
  });
});
