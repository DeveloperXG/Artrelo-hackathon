import { afterEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../../api/client';
import { irisApi } from './irisApi';

const ID = 'conv_fixture';
const ACTION = '00000000-0000-4000-8000-000000000001';
const closed = { success: true, data: { conversationId: ID, status: 'closed', serverTime: '2026-10-30T05:00:00.000Z' } };

function stubFetch(...responses: { body: unknown; status: number }[]) {
  const fetchMock = vi.fn(async () => {
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

describe('pagehide keepalive close', () => {
  it('is the existing close endpoint, sent keepalive with the existing bearer auth and only the action id', async () => {
    setToken('test-access-token');
    const fetchMock = stubFetch({ body: closed, status: 200 });
    await expect(irisApi.closeOnPagehide(ID, ACTION)).resolves.toMatchObject({ conversationId: ID, status: 'closed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/landlords/iris/conversations/${ID}/close`);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'include' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-access-token');
    expect(JSON.parse(String(init.body))).toEqual({ clientActionId: ACTION });
  });

  it('never refreshes the session: a 401 is final, with no second request', async () => {
    setToken('expired-access-token');
    const fetchMock = stubFetch({ body: { success: false, error: { code: 'not_authenticated' } }, status: 401 });
    await expect(irisApi.closeOnPagehide(ID, ACTION)).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/auth/refresh-token'))).toBe(false);
  });

  it('the ordinary close still refreshes as before (contrast)', async () => {
    setToken('expired-access-token');
    const fetchMock = stubFetch({ body: { success: false, error: { code: 'not_authenticated' } }, status: 401 });
    await expect(irisApi.closeConversation(ID, ACTION)).rejects.toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/auth/refresh-token'))).toBe(true);
  });
});
