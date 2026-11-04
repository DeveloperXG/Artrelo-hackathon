import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { ConfirmDialog } from './landlordUi';

const observed = vi.hoisted(() => ({ root: {} as Record<string, any>, content: {} as Record<string, any> }));
vi.mock('../ui/dialog', () => ({
  Dialog: ({ children, ...props }: { children: ReactNode }) => { observed.root = props; return <>{children}</>; },
  DialogContent: ({ children, ...props }: { children: ReactNode }) => { observed.content = props; return <div>{children}</div>; },
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

beforeEach(() => { observed.root = {}; observed.content = {}; });
describe('ConfirmDialog optional presentation seam', () => {
  it('preserves default content, labels and guarded caller callbacks without invoking confirmation', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const html = renderToStaticMarkup(<ConfirmDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} title="Delete this request?" description="Original authority copy." />);
    expect(observed.content.className).toBe('gap-0 overflow-hidden p-0 sm:max-w-md');
    for (const key of ['onOpenAutoFocus', 'onCloseAutoFocus', 'onFocusCapture']) expect(observed.content[key]).toBeUndefined();
    expect(html).toContain('Delete this request?');
    expect(html).toContain('Original authority copy.');
    expect(html).toContain('Cancel'); expect(html).toContain('Delete');
    expect(onConfirm).not.toHaveBeenCalled();
    observed.root.onOpenChange(false);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('forwards only the named class and focus callbacks unchanged without changing confirmation semantics', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const onOpenAutoFocus = vi.fn();
    const onCloseAutoFocus = vi.fn();
    const onFocusCapture = vi.fn();
    const html = renderToStaticMarkup(<ConfirmDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} title="Review the original question" confirmLabel="Confirm original action" cancelLabel="Keep record" className="lichen lichen-light lichen-d5" onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus} onFocusCapture={onFocusCapture} />);
    expect(observed.content.className).toContain('gap-0 overflow-hidden p-0 sm:max-w-md');
    expect(observed.content.className).toContain('lichen lichen-light lichen-d5');
    expect(observed.content.onOpenAutoFocus).toBe(onOpenAutoFocus);
    expect(observed.content.onCloseAutoFocus).toBe(onCloseAutoFocus);
    expect(observed.content.onFocusCapture).toBe(onFocusCapture);
    expect(Object.keys(observed.content).sort()).toEqual(['className', 'onCloseAutoFocus', 'onFocusCapture', 'onOpenAutoFocus']);
    expect(html).toContain('Confirm original action'); expect(html).toContain('Keep record');
    expect(onConfirm).not.toHaveBeenCalled(); expect(onOpenChange).not.toHaveBeenCalled();
  });
});
