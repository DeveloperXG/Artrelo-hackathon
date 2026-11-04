import { describe, expect, it } from 'vitest';
import fixtures from '../../contracts/iris.v2.fixtures.json';
import type { TurnView } from '../../types/irisV2';
import type { IrisApi } from './irisApi';
import { IrisController } from './irisController';
import { irisIdentityKey, sameIdentity } from './irisIdentity';

const F = fixtures as unknown as { conversation: unknown; preview: TurnView };
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const LANDLORD = { id: 'u1', role: 'landlord', email: 'Lena@example.test' };

describe('Iris identity', () => {
  it('changes with account, role or sign-in email, and needs an id and a role', () => {
    const key = irisIdentityKey(LANDLORD)!;
    expect(irisIdentityKey({ ...LANDLORD })).toBe(key);
    expect(irisIdentityKey({ ...LANDLORD, email: 'lena@example.test' })).toBe(key); // case only
    expect(irisIdentityKey({ _id: 'u1', role: 'landlord', email: 'lena@example.test' })).toBe(key);
    // The same account in its other role is a different identity.
    expect(irisIdentityKey({ ...LANDLORD, role: 'tenant' })).not.toBe(key);
    expect(irisIdentityKey({ ...LANDLORD, role: 'property_manager' })).not.toBe(key);
    expect(irisIdentityKey({ ...LANDLORD, id: 'u2' })).not.toBe(key);
    expect(irisIdentityKey({ ...LANDLORD, email: 'other@example.test' })).not.toBe(key);
    expect(irisIdentityKey(null)).toBeNull();
    expect(irisIdentityKey({ id: 'u1' })).toBeNull();
    expect(irisIdentityKey({ role: 'landlord' })).toBeNull();
  });

  it('a same-account role change elsewhere stops Iris before its next call and clears its state', async () => {
    let stored: unknown = { ...LANDLORD };
    const key = irisIdentityKey(stored)!;
    const calls: string[] = [];
    const api = {
      createConversation: async () => (calls.push('createConversation'), F.conversation),
      resolveContext: async (_id: string, body: { requestContextId: string | null; contextGeneration: number }) => (
        calls.push('resolveContext'),
        { segmentId: 'seg_a', contextGeneration: body.contextGeneration, requestContextId: null, contextKind: 'account', contextLabel: 'Your account policy' }
      ),
      postTurn: async () => {
        calls.push('postTurn');
        throw new Error('not reached');
      },
    } as unknown as IrisApi;
    const controller = new IrisController(api, { isSignedIn: () => sameIdentity(key, stored) });
    controller.setRoute(null);
    await controller.open();
    await flush();
    expect(controller.getState().context.status).toBe('resolved');
    expect(calls).toEqual(['createConversation', 'resolveContext']);

    // Another tab switches this account to its tenant role.
    stored = { ...LANDLORD, role: 'tenant' };
    await controller.send('What is my default quota?');
    await flush();
    expect(calls).toEqual(['createConversation', 'resolveContext']);
    const s = controller.getState();
    expect(s.phase).toBe('signed_out');
    expect(s.segments).toEqual([]);
    expect(s.conversationId).toBeNull();
  });
});
