import { useState } from 'react';
import { DoorOpen, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { TenantAPI } from '../../api/client';
import type { TenantMoveOutStatus } from '../../types/landlord';
import { Button } from '../ui/button';

/**
 * Shown across the tenant portal while a move-out is pending, and after one
 * completes (or the unit was retired) to explain why New request is gone.
 */
export default function TenantMoveOutBanner({
  status,
  onChanged,
}: {
  status: TenantMoveOutStatus | null;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  if (!status) return null;

  const where = [status.unitLabel, status.propertyName].filter(Boolean).join(' at ');

  if (status.linked && status.moveOut?.status === 'requested') {
    const confirm = async () => {
      setBusy(true);
      try {
        await TenantAPI.confirmMoveOut();
        await onChanged();
      } catch (error) {
        // e.g. an open request on the unit still has to be finished first.
        toast.error(error instanceof Error ? error.message : 'Could not confirm your move-out');
      } finally {
        setBusy(false);
      }
    };

    return (
      <div
        data-testid="tenant-move-out-banner"
        className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-lichen-line in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:[overflow-wrap:anywhere]"
      >
        <div className="flex items-start gap-3">
          <DoorOpen className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 in-[.lichen-d5]:text-lichen-text" />
          <div className="text-sm text-amber-900 in-[.lichen-d5]:min-w-0 in-[.lichen-d5]:text-lichen-text">
            <div className="font-semibold">Your property manager is retiring {where || 'your unit'}.</div>
            <div className="mt-0.5 text-amber-800 in-[.lichen-d5]:text-lichen-text">
              Confirm once you've moved out. Your past requests stay available to you.
            </div>
          </div>
        </div>
        <Button
          data-testid="tenant-confirm-move-out"
          className="shrink-0 bg-amber-600 text-white hover:bg-amber-700 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          I've moved out
        </Button>
      </div>
    );
  }

  if (!status.linked) {
    return (
      <div
        data-testid="tenant-no-unit-banner"
        className="mb-6 flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-600 shadow-sm in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card in-[.lichen-d5]:text-meta"
      >
        <DoorOpen className="mt-0.5 h-5 w-5 shrink-0 text-slate-400 in-[.lichen-d5]:text-meta" />
        <div>
          <div className="font-semibold text-slate-800 in-[.lichen-d5]:text-ink">You're not linked to a unit</div>
          <div className="mt-0.5">
            You can still view your past requests. To file a new one, ask your property manager for a new invite.
          </div>
        </div>
      </div>
    );
  }

  return null;
}
