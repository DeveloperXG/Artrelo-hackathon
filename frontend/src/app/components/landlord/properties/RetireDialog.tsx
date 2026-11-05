import { REMAINDER_PORTAL } from '../remainderPresentation';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Archive, Clock, Loader2, Send, Trash2, Users, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { LandlordAPI } from '../../../api/client';
import type { DeletionCheck, DeletionBlockingTenant } from '../../../types/landlord';
import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../../ui/dialog';

export type RetireTarget = { kind: 'property' | 'unit'; id: string; name: string };

const formatDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : '';

function TenantRow({ tenant }: { tenant: DeletionBlockingTenant }) {
  const asked = tenant.moveOut?.status === 'requested';
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-slate-800 lichen:whitespace-normal lichen:overflow-visible lichen:text-clip lichen:[overflow-wrap:anywhere] lichen:text-ink">{tenant.name}</div>
        <div className="truncate text-xs text-slate-500 lichen:whitespace-normal lichen:overflow-visible lichen:text-clip lichen:[overflow-wrap:anywhere] lichen:text-meta">{tenant.unitLabel}</div>
      </div>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium  lichen:text-xs ${
          asked ? "bg-amber-50 text-amber-700 lichen:bg-lichen-tint lichen:text-lichen-text" : "bg-slate-100 text-slate-600 lichen:bg-chip lichen:text-meta"
        }`}
      >
        {asked ? `Asked ${formatDate(tenant.moveOut?.requestedAt || null)}` : 'Not asked yet'}
      </span>
    </li>
  );
}

/**
 * Deleting a property or unit. The server decides (deletion-check); this only
 * explains it. Tenants still linked block it -- the landlord sends them a
 * move-out notice and the delete unlocks once they have all moved out. Open
 * jobs block it too. Once clear, anything with request history is archived
 * rather than deleted, and the dialog says which before the click.
 */
export default function RetireDialog({
  target,
  onOpenChange,
  onRetired,
}: {
  target: RetireTarget | null;
  onOpenChange: (open: boolean) => void;
  onRetired: (action: 'archived' | 'deleted') => void | Promise<void>;
}) {
  const [check, setCheck] = useState<DeletionCheck | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'' | 'notice' | 'retire'>('');

  const load = useCallback(async () => {
    if (!target) return;
    setCheck(null);
    setLoadError('');
    try {
      const response =
        target.kind === 'property'
          ? await LandlordAPI.propertyDeletionCheck(target.id)
          : await LandlordAPI.unitDeletionCheck(target.id);
      setCheck(response.data as DeletionCheck);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not check this right now.');
    }
  }, [target]);

  useEffect(() => {
    void load();
  }, [load]);

  const sendNotice = async () => {
    if (!target) return;
    setBusy('notice');
    try {
      const response = await LandlordAPI.sendMoveOutNotice(target.kind, target.id);
      const data = response.data as { notified: number; check: DeletionCheck | null };
      if (data.check) setCheck(data.check);
      // The tenants are told by email and in their portal -- nothing on this
      // screen shows that a message went out, so say so.
      toast.success(`Move-out notice sent to ${data.notified} tenant${data.notified === 1 ? '' : 's'}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send the notice');
    } finally {
      setBusy('');
    }
  };

  const retire = async () => {
    if (!target) return;
    setBusy('retire');
    try {
      const response =
        target.kind === 'property'
          ? await LandlordAPI.deleteProperty(target.id)
          : await LandlordAPI.deleteUnit(target.id);
      const action = (response.data as { action: 'archived' | 'deleted' }).action;
      await onRetired(action);
    } catch (error) {
      // A 409 means something changed since the check (a tenant signed up, a
      // job opened). Re-check so the dialog shows the new reason.
      toast.error(error instanceof Error ? error.message : 'Could not delete this');
      await load();
    } finally {
      setBusy('');
    }
  };

  const tenants = check?.blockers.tenants || [];
  const openRequests = check?.blockers.openRequests || 0;
  const waiting = tenants.filter((tenant) => tenant.moveOut?.status === 'requested').length;
  const allAsked = tenants.length > 0 && waiting === tenants.length;
  const noun = target?.kind === 'property' ? 'property' : 'unit';
  const name = target?.name || '';

  let title = `Delete ${name}`;
  if (check?.blocked) title = `${name} can't be deleted yet`;
  else if (check?.action === 'archive') title = `Archive ${name}?`;

  return (
    <Dialog open={Boolean(target)} onOpenChange={(next) => (busy ? null : onOpenChange(next))}>
      <DialogContent className={`${REMAINDER_PORTAL} gap-0 p-0 sm:max-w-md`} data-testid="retire-dialog">
        <div className="px-6 pb-5 pt-7">
          <div className="flex items-start gap-3">
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl  lichen:rounded-lg ${
                check?.blocked ? "bg-amber-50 text-amber-600 lichen:bg-lichen-tint lichen:text-lichen-text" : "bg-rose-50 text-rose-600 lichen:bg-alert-tint lichen:text-alert-text"
              }`}
            >
              {check?.action === 'archive' ? <Archive className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
            </div>
            <div className="min-w-0 space-y-1">
              <DialogTitle className="text-lg font-semibold text-slate-900 lichen:text-ink">{title}</DialogTitle>
              <DialogDescription className="text-sm leading-relaxed text-slate-500 lichen:text-meta">
                {!check && !loadError ? 'Checking who and what is still linked to it…' : null}
                {loadError}
                {check && tenants.length > 0
                  ? `${tenants.length} tenant${tenants.length === 1 ? ' lives' : 's live'} here. Before this ${noun} can be deleted, ${
                      tenants.length === 1 ? 'they need' : 'they all need'
                    } to move out.`
                  : null}
                {check && !tenants.length && openRequests > 0
                  ? `${openRequests} job${openRequests === 1 ? ' is' : 's are'} still open here. Finish or cancel ${
                      openRequests === 1 ? 'it' : 'them'
                    } first.`
                  : null}
                {check && !check.blocked && check.action === 'archive'
                  ? `It has past jobs, so it will be archived instead of deleted. It leaves your lists and invite options, and its job history stays available under Archived.`
                  : null}
                {check && !check.blocked && check.action === 'delete'
                  ? target?.kind === 'property'
                    ? "This removes the property and its units. This can't be undone."
                    : "This can't be undone."
                  : null}
              </DialogDescription>
            </div>
          </div>

          {!check && !loadError ? (
            <div className="mt-5 flex justify-center text-slate-400 lichen:text-meta">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : null}

          {tenants.length > 0 ? (
            <div className="mt-5 rounded-xl border border-slate-200 lichen:rounded-lg lichen:border-hairline">
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5 lichen:border-hairline">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 lichen:text-xs lichen:normal-case lichen:tracking-normal lichen:text-meta">
                  <Users className="h-3.5 w-3.5" />
                  Tenants
                </span>
                {waiting > 0 ? (
                  <span className="flex items-center gap-1 text-xs text-amber-700 lichen:text-lichen-text" data-testid="retire-waiting">
                    <Clock className="h-3.5 w-3.5" />
                    Waiting on {waiting} of {tenants.length}
                  </span>
                ) : null}
              </div>
              <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto px-4 lichen:divide-hairline">
                {tenants.map((tenant) => (
                  <TenantRow key={tenant._id} tenant={tenant} />
                ))}
              </ul>
              <p className="border-t border-slate-100 px-4 py-2.5 text-xs leading-5 text-slate-500 lichen:border-hairline lichen:text-meta">
                Each tenant confirms in their portal. If someone has already left, move them out from the{' '}
                <Link to="/dashboard/tenants" className="font-medium text-[#137fec] hover:underline lichen:text-lichen-text">
                  Tenants page
                </Link>
                .
              </p>
            </div>
          ) : null}

          {openRequests > 0 && check ? (
            <Link
              to={`/dashboard/requests?propertyId=${check.propertyId}`}
              className="mt-3 flex items-center gap-2 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-900 transition hover:border-amber-200 lichen:rounded-lg lichen:border-lichen-line lichen:bg-lichen-tint lichen:text-lichen-text lichen:hover:border-lichen-line"
            >
              <Wrench className="h-4 w-4 shrink-0" />
              {openRequests} open job{openRequests === 1 ? '' : 's'} {target?.kind === 'unit' ? 'in this unit' : 'at this property'}.
              View requests
            </Link>
          ) : null}
        </div>

        <DialogFooter className="gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4 sm:gap-3 lichen:border-hairline lichen:bg-well">
          <Button
            variant="outline"
            className="flex-1 border-slate-200 bg-white lichen:border-hairline lichen:bg-card"
            disabled={Boolean(busy)}
            onClick={() => onOpenChange(false)}
          >
            {check?.blocked ? 'Close' : 'Cancel'}
          </Button>

          {tenants.length > 0 ? (
            <Button
              data-testid="retire-send-notice"
              className="flex-1 bg-[#137fec] text-white hover:bg-[#137fec]/90 lichen:bg-primary lichen:hover:bg-chip lichen:text-primary-foreground"
              disabled={Boolean(busy)}
              onClick={() => void sendNotice()}
            >
              {busy === 'notice' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {allAsked ? 'Resend notice' : `Send move-out notice${tenants.length > 1 ? ` to all ${tenants.length}` : ''}`}
            </Button>
          ) : check && !check.blocked ? (
            <Button
              data-testid="retire-confirm"
              className="flex-1 bg-rose-600 text-white hover:bg-rose-700 lichen:bg-alert-text lichen:hover:bg-alert-text/90"
              disabled={Boolean(busy)}
              onClick={() => void retire()}
            >
              {busy === 'retire' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : check.action === 'archive' ? (
                <Archive className="mr-2 h-4 w-4" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {check.action === 'archive' ? `Archive ${noun}` : `Delete ${noun}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
