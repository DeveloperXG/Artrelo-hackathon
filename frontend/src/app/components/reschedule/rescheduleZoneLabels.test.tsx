import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import RescheduleRequestForm from './RescheduleRequestForm';
import { PreviewResult } from './AvailabilityPreview';
import type { AvailabilityPreview } from '../../types/booking';
vi.mock('../../api/client', () => ({ BookingAPI: {}, ApiError: class extends Error {} }));
const nodes = (node: ReactNode): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement(node) ? [node as ReactElement<any>, ...nodes((node as ReactElement<any>).props.children)] : [];
describe('preview versus exact-form timezone copy', () => {
  it('labels the local fields honestly when Intl metadata is missing and retains explicit preview UTC', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({ resolvedOptions: () => ({ timeZone: undefined }) } as unknown as Intl.DateTimeFormat);
    try {
      const html = renderToStaticMarkup(<RescheduleRequestForm requestId="synthetic_request" revision={4} onSent={vi.fn()} onReconcile={vi.fn()} onCancel={vi.fn()} />);
      expect(html).toContain('local device time; zone name unavailable');
      expect(html).not.toContain('time zone (UTC)');
      expect(html).toContain('Preview time zone');
      expect(html).toContain('value="UTC"');
      expect(html).toContain('Exact date and time fields use this device');
    } finally { vi.restoreAllMocks(); }
  });
  it('explains the display conversion and forwards the exact server windows on Apply', () => {
    const windows = [{ start: '2026-11-06T09:00:00Z', end: '2026-11-06T12:00:00Z' }];
    const preview = { windows, timeZone: 'UTC', source: 'local_rules', modelStatus: 'not_used', needsClarification: false, question: null } as AvailabilityPreview;
    const onApply = vi.fn();
    const element = <PreviewResult preview={preview} mode="windows" onApply={onApply} />;
    const html = renderToStaticMarkup(element);
    expect(html).toContain('Applying these times changes their display, not the instants.');
    const apply = nodes(PreviewResult({ preview, mode: 'windows', onApply })).find(node => node.props['data-testid'] === 'availability-apply')!;
    apply.props.onClick(); expect(onApply).toHaveBeenCalledExactlyOnceWith(windows);
    expect(windows).toEqual([{ start: '2026-11-06T09:00:00Z', end: '2026-11-06T12:00:00Z' }]);
  });
});
