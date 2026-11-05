import { Link } from 'react-router-dom';
import { ChevronRight, HardHat, User } from 'lucide-react';
import { archivedTitle, finishedAt, outcomeLabel, type ArchivedRequest } from './archiveFormat';
import RequestIdentity from '../landlord/RequestIdentity';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMoney = (amount: number) =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(amount);

/**
 * One archived request in a history list. The landlord sees cost, vendor and
 * tenant; a tenant never sees a cost (the tenant payload does not carry one,
 * and `showCost` keeps the row honest about that).
 */
export default function ArchivedRequestRow({
  request,
  to,
  showCost = false,
  showTenant = false,
}: {
  request: ArchivedRequest;
  to: string;
  showCost?: boolean;
  showTenant?: boolean;
}) {
  const completed = request.status === 'completed';
  const vendor = request.vendorId && typeof request.vendorId === 'object' ? request.vendorId.name : null;
  const tenant =
    request.tenantId && typeof request.tenantId === 'object'
      ? [request.tenantId.firstName, request.tenantId.lastName].filter(Boolean).join(' ')
      : null;

  return (
    <Link
      to={showCost || showTenant ? `${to}?tab=work` : to}
      data-testid={`archived-request-${request._id}`}
      className="group flex items-center gap-3 rounded-xl border border-slate-100 bg-white px-4 py-3 transition hover:border-[#137fec]/30 hover:bg-slate-50/60 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-hairline in-[.lichen-d5]:bg-card in-[.lichen-d5]:hover:bg-well in-[.lichen-d5]:hover:border-control-border in-[.lichen-remainder]:rounded-lg in-[.lichen-remainder]:border-hairline in-[.lichen-remainder]:bg-card in-[.lichen-remainder]:hover:border-lichen-line in-[.lichen-remainder]:hover:bg-well"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 in-[.lichen-d5]:flex-wrap">
          <span className="truncate text-sm font-medium text-slate-900 in-[.lichen-d5]:text-ink in-[.lichen-d5]:whitespace-normal in-[.lichen-d5]:[overflow-wrap:anywhere] in-[.lichen-remainder]:whitespace-normal in-[.lichen-remainder]:overflow-visible in-[.lichen-remainder]:text-clip in-[.lichen-remainder]:[overflow-wrap:anywhere] in-[.lichen-remainder]:text-ink">{archivedTitle(request)}</span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset  in-[.lichen-remainder]:text-xs ${
              completed ? "bg-emerald-50 text-emerald-700 ring-emerald-200 in-[.lichen-d5]:bg-mist-tint in-[.lichen-d5]:text-mist-text in-[.lichen-d5]:ring-0 in-[.lichen-remainder]:bg-mist-tint in-[.lichen-remainder]:text-mist-text" : "bg-slate-100 text-slate-600 ring-slate-200 in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-meta in-[.lichen-remainder]:bg-chip in-[.lichen-remainder]:text-meta"
            }`}
          >
            {outcomeLabel(request)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500 in-[.lichen-d5]:text-meta in-[.lichen-remainder]:text-meta">
          {showTenant || showCost ? <RequestIdentity id={request._id} createdAt={request.createdAt} /> : null}
          <span>
            {request.category ? `${request.category} · ` : ''}
            {completed ? 'Completed' : 'Ended'} {fmtDate(finishedAt(request))}
          </span>
          {vendor ? (
            <span className="inline-flex items-center gap-1">
              <HardHat className="h-3 w-3 text-slate-400 in-[.lichen-d5]:text-meta in-[.lichen-remainder]:text-meta" />
              {vendor}
            </span>
          ) : null}
          {showTenant && tenant ? (
            <span className="inline-flex items-center gap-1">
              <User className="h-3 w-3 text-slate-400 in-[.lichen-d5]:text-meta in-[.lichen-remainder]:text-meta" />
              {tenant}
            </span>
          ) : null}
        </div>
      </div>
      {showCost && completed && request.finalCost ? (
        <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-700 in-[.lichen-d5]:text-ink in-[.lichen-remainder]:font-mono in-[.lichen-remainder]:text-ink">{fmtMoney(request.finalCost)}</span>
      ) : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-400 in-[.lichen-d5]:text-meta in-[.lichen-d5]:group-hover:text-meta in-[.lichen-d5]:group-hover:translate-x-0 in-[.lichen-remainder]:text-meta in-[.lichen-remainder]:group-hover:text-meta" />
      {showCost || showTenant ? <span className="sr-only">Open work record</span> : null}
    </Link>
  );
}
