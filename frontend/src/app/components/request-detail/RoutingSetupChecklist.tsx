import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ListChecks } from 'lucide-react';
import { Button } from '../ui/button';
import type { RoutingSetup } from '../../types/landlord';

/**
 * What stands between this landlord and vendor routing: at least one vendor,
 * and "Max vendors contacted per request" of at least 1 (it starts at 0).
 * Both are checked again by the server, which refuses with
 * routing_setup_incomplete -- this is the same answer, shown before the click.
 *
 * Steps tick off live: the vendor step re-reads after the inline Add vendor
 * dialog saves, and the cap step re-reads when the landlord comes back from
 * the Policy page (RequestDetail refreshes on focus).
 */
export default function RoutingSetupChecklist({
  setup,
  onAddVendor,
}: {
  setup: RoutingSetup;
  onAddVendor: () => void;
}) {
  const hasVendors = !setup.missing.includes('vendors');
  const hasCap = !setup.missing.includes('max_vendors');

  return (
    <div
      className="mb-5 rounded-xl border border-[#137fec]/20 bg-[#137fec]/[0.04] px-4 py-4 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-lichen-tint"
      data-testid="routing-setup-checklist"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-[#137fec] shadow-sm in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-lichen-text in-[.lichen-d3]:shadow-none">
          <ListChecks className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">Before Artrelo can contact vendors</div>
          <div className="mt-0.5 text-sm text-slate-500 in-[.lichen-d3]:text-meta">
            Finish these and recommendations unlock for every request.
          </div>
        </div>
      </div>

      <ol className="mt-4 space-y-2">
        <SetupStep
          index={1}
          done={hasVendors}
          title="Add at least one vendor"
          detail={
            hasVendors
              ? `${setup.activeVendorCount} active vendor${setup.activeVendorCount === 1 ? '' : 's'} in your network.`
              : 'Recommendations come only from vendors you add.'
          }
          action={
            hasVendors ? null : (
              <Button
                size="sm"
                onClick={onAddVendor}
                className="bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
                data-testid="routing-setup-add-vendor"
              >
                Add a vendor
              </Button>
            )
          }
          testId="routing-setup-step-vendors"
        />
        <SetupStep
          index={2}
          done={hasCap}
          title="Set max vendors contacted per request"
          detail={
            hasCap
              ? `Up to ${setup.maxOutreachAttempts} vendor${setup.maxOutreachAttempts === 1 ? '' : 's'} per request.`
              : 'It starts at 0, so no vendor is contacted until you choose at least 1.'
          }
          action={
            hasCap ? null : (
              <Link
                to="/dashboard/policy#vendor-outreach"
                className="inline-flex h-8 items-center justify-center rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink in-[.lichen-d3]:hover:bg-well"
                data-testid="routing-setup-open-policy"
              >
                Open Policy
              </Link>
            )
          }
          testId="routing-setup-step-max-vendors"
        />
      </ol>
    </div>
  );
}

function SetupStep({
  index,
  done,
  title,
  detail,
  action,
  testId,
}: {
  index: number;
  done: boolean;
  title: string;
  detail: string;
  action: ReactNode;
  testId: string;
}) {
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-slate-200/80 bg-white px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card"
      data-testid={testId}
      data-done={done || undefined}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {done ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500 in-[.lichen-d3]:text-mist-text" aria-label="Done" />
        ) : (
          <span
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-300 text-[11px] font-semibold text-slate-500 in-[.lichen-d3]:border-control-border in-[.lichen-d3]:text-meta"
            aria-label={`Step ${index}`}
          >
            {index}
          </span>
        )}
        <div className="min-w-0">
          <div className={`text-sm font-semibold ${done ? "text-slate-500 line-through decoration-slate-300 in-[.lichen-d3]:text-meta" : "text-slate-800 in-[.lichen-d3]:text-ink"}`}>
            {title}
          </div>
          <div className="text-xs text-slate-500 in-[.lichen-d3]:text-meta">{detail}</div>
        </div>
      </div>
      {action ? <div className="shrink-0 sm:pl-3">{action}</div> : null}
    </li>
  );
}
