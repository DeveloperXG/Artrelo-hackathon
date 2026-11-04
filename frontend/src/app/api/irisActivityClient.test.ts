import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandlordAPI, setToken } from './client';

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

describe('Iris activity client', () => {
  it('reads the grouped list with the existing bearer auth and only the set parameters', async () => {
    setToken('test-access-token');
    const fetchMock = stubFetch({ success: true, data: { version: 1, requests: [], nextCursor: null } });
    const response = await LandlordAPI.listIrisActivity({ limit: 5, activeOnly: true });
    expect(response.data).toEqual({ version: 1, requests: [], nextCursor: null });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/landlords/iris-activity?limit=5&activeOnly=true');
    expect(init.method).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-access-token');
  });

  it('passes an opaque cursor through encoded and encodes the request id', async () => {
    const fetchMock = stubFetch({ success: true, data: { version: 1, request: {}, events: [], nextCursor: null } });
    await LandlordAPI.getRequestIrisActivity('req/../x', { limit: 50, cursor: 'a+b/c==' });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('/api/v1/landlords/requests/req%2F..%2Fx/iris-activity?limit=50&cursor=a%2Bb%2Fc%3D%3D');
  });

  it('omits activeOnly when false and the cursor when null', async () => {
    const fetchMock = stubFetch({ success: true, data: { version: 1, requests: [], nextCursor: null } });
    await LandlordAPI.listIrisActivity({ cursor: null, activeOnly: false });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/landlords/iris-activity');
  });

  it('surfaces a 404 for another landlord’s request as an ApiError', async () => {
    stubFetch({ success: false, message: 'Request not found' }, 404);
    await expect(LandlordAPI.getRequestIrisActivity('someone-else')).rejects.toMatchObject({ status: 404 });
  });
});
