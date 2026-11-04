import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
const host = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, api: vi.fn(), refresh: vi.fn(), error: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => { const i = host.cursor++; if (!(i in host.slots)) host.slots[i] = initial; return [host.slots[i], (value: unknown) => { host.slots[i] = value; }]; } }));
vi.mock('../../api/client', () => ({ LandlordAPI: { markDirectPaymentPaid: (...args: unknown[]) => host.api(...args) } }));
vi.mock('../../hooks/landlord/useLandlordBadges', () => ({ refreshLandlordBadges: () => host.refresh() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (...args: unknown[]) => host.error(...args) } }));
vi.mock('../request-detail/d3Presentation', async original => ({ ...await original<typeof import('../request-detail/d3Presentation')>(), useD3Presentation: () => false }));
import { MarkDirectPaidDialog } from './DirectPayments';

const nodes = (node: ReactNode): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement(node) ? [node as ReactElement<any>, ...nodes((node as ReactElement<any>).props.children)] : [];
const payment = { appointmentId: 'synthetic_visit', amount: 0, vendorName: 'Synthetic vendor', issueTitle: 'Synthetic repair' };
beforeEach(() => { vi.clearAllMocks(); host.slots = []; host.cursor = 0; });

describe('direct payment presentation opt-in keeps the existing recording contract', () => {
  it.each([undefined, true])('keeps raw reference/trim, exact endpoint identity, busy close guard and successful callbacks with presentation=%s', async presentation => {
    let release!: () => void; host.api.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const onClose = vi.fn(), onMarked = vi.fn(), props = { payment, onClose, onMarked, presentation };
    const render = () => { host.cursor = 0; return MarkDirectPaidDialog(props); }; let tree = render();
    expect(tree.props.description).toContain("Artrelo doesn't move this money; this only records it."); expect(tree.props.title).toContain('$0.00');
    const input = () => nodes(tree).find(n => n.props['data-testid'] === 'direct-payment-reference')!.props;
    const submit = () => nodes(tree).find(n => n.props['data-testid'] === 'direct-payment-confirm')!.props;
    input().onChange({ target: { value: '  synthetic reference  ' } }); tree = render(); expect(input().value).toBe('  synthetic reference  '); expect(input().maxLength).toBe(120); expect(input()['aria-label']).toBe('Reference (optional)');
    const pending = submit().onClick(); tree = render(); expect(submit().disabled).toBe(true); tree.props.onOpenChange(false); expect(onClose).not.toHaveBeenCalled();
    expect(host.api).toHaveBeenCalledExactlyOnceWith('synthetic_visit', 'synthetic reference'); release(); await pending; tree = render();
    expect(onClose).toHaveBeenCalledOnce(); expect(onMarked).toHaveBeenCalledOnce(); expect(host.refresh).toHaveBeenCalledOnce(); expect(input().value).toBe(''); expect(submit().disabled).toBe(false);
  });
  it('retains the draft after refusal, exposes the actual error and never silently retries or claims paid', async () => {
    host.api.mockRejectedValueOnce(new Error('Synthetic refusal')); const onClose = vi.fn(), onMarked = vi.fn();
    const render = () => { host.cursor = 0; return MarkDirectPaidDialog({ payment, onClose, onMarked, presentation: true }); }; let tree = render();
    nodes(tree).find(n => n.props['data-testid'] === 'direct-payment-reference')!.props.onChange({ target: { value: 'Synthetic reference' } }); tree = render();
    await nodes(tree).find(n => n.props['data-testid'] === 'direct-payment-confirm')!.props.onClick(); tree = render();
    expect(host.error).toHaveBeenCalledExactlyOnceWith('Synthetic refusal'); expect(host.api).toHaveBeenCalledOnce(); expect(onMarked).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(nodes(tree).find(n => n.props['data-testid'] === 'direct-payment-reference')!.props.value).toBe('Synthetic reference');
    tree.props.onOpenChange(false); tree = render(); expect(onClose).toHaveBeenCalledOnce(); expect(nodes(tree).find(n => n.props['data-testid'] === 'direct-payment-reference')!.props.value).toBe('');
  });
});
