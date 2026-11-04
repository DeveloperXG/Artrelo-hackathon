import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/react';
import { scrubEvent, scrubUrl } from './monitoring';

const TOKEN = 'Ab3_-'.repeat(9); // 45 chars, the shape of a 32-byte base64url token

describe('error report scrubbing', () => {
  it('redacts link tokens from paths and drops query strings and fragments', () => {
    expect(scrubUrl(`https://artrelo.com/vendor-job/${TOKEN}?x=1#y`)).toBe('https://artrelo.com/vendor-job/[redacted]');
    expect(scrubUrl(`/vendor-hub/session/${TOKEN}/next`)).toBe('/vendor-hub/session/[redacted]/next');
    expect(scrubUrl(`/landlord-invite#${TOKEN}`)).toBe('/landlord-invite');
  });

  it('leaves ordinary ids alone, so a report still says which request', () => {
    expect(scrubUrl('/dashboard/requests/6acf7ddfa3e6961b52d88b74')).toBe('/dashboard/requests/6acf7ddfa3e6961b52d88b74');
  });

  it('scrubs the page URL, messages and exception text of an event', () => {
    const event = scrubEvent({
      type: undefined,
      request: { url: `https://artrelo.com/vendor-response/${TOKEN}`, query_string: 'a=1', headers: { a: '1' } },
      message: `failed to load /vendor-response/${TOKEN}`,
      exception: { values: [{ type: 'Error', value: `bad token ${TOKEN}` }] },
    } as ErrorEvent);
    expect(event.request).toEqual({ url: 'https://artrelo.com/vendor-response/[redacted]' });
    expect(event.message).toBe('failed to load /vendor-response/[redacted]');
    expect(event.exception?.values?.[0].value).toBe('bad token [redacted]');
  });
});
