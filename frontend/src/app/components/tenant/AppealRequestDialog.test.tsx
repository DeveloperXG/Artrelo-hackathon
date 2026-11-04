import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import appealNoteFixture from '../../../../qa/d5-appeal/note747.json';

// Deterministic local-hook host. Portal/focus/actual DOM input enforcement is
// required separately in the real-component browser replay; no DOM dependency.
const host = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const i = host.cursor++; if (!host.slots[i]) host.slots[i] = { value: initial }; return [host.slots[i].value, (value: unknown) => { if (!Object.is(value, host.slots[i].value)) { host.slots[i].value = value; host.dirty = true; } }]; },
  useEffect: (effect: () => void, deps: unknown[]) => { const i = host.cursor++, old = host.slots[i]; if (!old || old.deps.some((v: unknown, k: number) => !Object.is(v, deps[k]))) { host.slots[i] = { deps }; host.effects.push(effect); } },
}));
import { AppealRequestDialog, type AppealRequestTarget } from './AppealRequestDialog';
import { Dialog } from '../ui/dialog';
import { Button } from '../ui/button';
type Props = Parameters<typeof AppealRequestDialog>[0];
function nodes(node: ReactNode): ReactElement<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!isValidElement(node)) return []; const e = node as ReactElement<any>; return [e, ...nodes(e.props.children)]; }
let tree: ReactNode, props: Props;
const target = (id = 'request_a'): AppealRequestTarget => ({ requestId: id, issueTitle: 'Synthetic kitchen leak', summary: 'Synthetic original summary', rejectionReason: 'Synthetic server refusal' });
function render(next = props) { props = next; let loops = 0; do { if (++loops > 6) throw Error('Hook host render loop'); host.cursor = 0; host.dirty = false; tree = AppealRequestDialog(props); host.effects.splice(0).forEach(effect => effect()); } while (host.dirty); }
const field = () => nodes(tree).find(e => e.props['data-testid'] === 'appeal-note')!.props;
const submit = () => nodes(tree).find(e => e.props['data-testid'] === 'confirm-appeal')!.props;
const cancel = () => nodes(tree).find(e => e.type === Button && e.props.children === 'Cancel')!.props;
const root = () => nodes(tree).find(e => e.type === Dialog)!.props;
const type = (value: string) => { field().onChange({ target: { value } }); render(); };
const note747 = appealNoteFixture.note;
beforeEach(() => { host.slots = []; host.effects = []; host.cursor = 0; host.dirty = false; props = { target: target(), busy: false, onClose: vi.fn(), onConfirm: vi.fn().mockResolvedValue(undefined) }; });

describe('AppealRequestDialog backward-compatible note control', () => {
  it('retains the uncontrolled list caller lifecycle: same target preserves, different/null target resets', () => {
    render(); type(note747); expect(field().value).toBe(note747);
    render({ ...props, target: { ...target(), summary: 'Fresh same-target summary' } }); expect(field().value).toBe(note747);
    render({ ...props, target: target('request_b') }); expect(field().value).toBe(''); type('Second request');
    render({ ...props, target: null }); expect(root().open).toBe(false); expect(field().value).toBe('');
    render({ ...props, target: target('request_b') }); expect(field().value).toBe('');
  });
  it('uses the parent raw note with a fresh deterministic child state bank without calling change/reset', () => {
    const onNoteChange = vi.fn(); render({ ...props, note: note747, onNoteChange }); expect(field().value).toBe(note747);
    host.slots = []; host.effects = []; render(); expect(field().value).toBe(note747); expect(onNoteChange).not.toHaveBeenCalled();
    field().onChange({ target: { value: 'Edited raw note  ' } }); expect(onNoteChange).toHaveBeenCalledExactlyOnceWith('Edited raw note  '); expect(field().value).toBe(note747);
    render({ ...props, note: 'Edited raw note  ' }); expect(field().value).toBe('Edited raw note  ');
  });
  it.each([false, true])('preserves trim/required/max1000/counter and exact confirm payload for controlled=%s', async controlled => {
    if (controlled) render({ ...props, note: ' \n ', onNoteChange: vi.fn() }); else { render(); type(' \n '); }
    expect(submit().disabled).toBe(true); expect(field().maxLength).toBe(1000); expect(field().id).toBe('appeal-note');
    expect(nodes(tree).find(e => e.type === 'label' && e.props.htmlFor === 'appeal-note')).toBeTruthy();
    if (controlled) render({ ...props, note: note747 }); else type(note747);
    expect(note747).toHaveLength(747); expect(field().value).toBe(note747); expect(submit().disabled).toBe(false);
    await submit().onClick(); expect(props.onConfirm).toHaveBeenCalledExactlyOnceWith(note747.trim()); expect(field().value).toBe(note747);
    expect(nodes(tree).some(e => Array.isArray(e.props.children) && e.props.children.includes(747) && e.props.children.includes('/1000'))).toBe(true);
  });
  it.each([false, true])('preserves busy field/submit/cancel and guarded outside/Escape close for controlled=%s', controlled => {
    const onClose = vi.fn(); render(controlled ? { ...props, busy: true, note: note747, onNoteChange: vi.fn(), onClose } : { ...props, busy: true, onClose });
    expect(field().disabled).toBe(true); expect(submit().disabled).toBe(true); expect(cancel().disabled).toBe(true); root().onOpenChange(false); expect(onClose).not.toHaveBeenCalled();
    render({ ...props, busy: false }); root().onOpenChange(false); expect(onClose).toHaveBeenCalledTimes(1);
  });
});
