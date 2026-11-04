import { Link } from 'react-router-dom';
import { AlertCircle, Loader2, Plus, RotateCcw, ShieldAlert } from 'lucide-react';
import { Button } from '../ui/button';
import type { CreationGate } from '../../lib/requestWorkflow';

/**
 * The normal New Request button. Grey and inert until the server has said a
 * routine request may start; the reason sits beside it, not in a toast.
 */
export function NewRequestButton({
  gate,
  linked,
  onClick,
}: {
  gate: CreationGate;
  linked: boolean;
  onClick: () => void;
}) {
  const allowed = linked && gate.status === 'allowed';
  return (
    <Button
      data-testid="new-request-btn"
      onClick={onClick}
      disabled={!allowed}
      aria-disabled={!allowed}
      aria-describedby={allowed ? undefined : 'new-request-gate'}
      className={`gap-2 ${
        allowed
          ? 'bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90'
          : "cursor-not-allowed bg-slate-200 text-slate-500 hover:bg-slate-200 disabled:opacity-100 in-[.lichen-d5]:text-meta"
      }`}
    >
      {gate.status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
      New Request
    </Button>
  );
}

/** Always available with a linked unit, whatever the normal limits say. */
export function SafetyConcernLink({ className = '' }: { className?: string }) {
  return (
    <Link
      to="/portal/safety"
      data-testid="safety-concern-link"
      className={`inline-flex items-center gap-1.5 rounded-md text-sm font-semibold text-rose-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 in-[.lichen-d5]:text-alert-text in-[.lichen-d5]:[overflow-wrap:anywhere] ${className}`}
    >
      <ShieldAlert className="h-4 w-4" aria-hidden="true" />
      Report a safety concern
    </Link>
  );
}

/**
 * Why New Request is grey: still checking, the check failed (with Retry), or
 * the server said no and why. Renders nothing when a request may start.
 */
export function CreationGateNotice({
  gate,
  onRetry,
  className = '',
  showSafetyLink = true,
}: {
  gate: CreationGate;
  onRetry: () => void;
  className?: string;
  /** Off where the page already shows the safety link beside New Request,
   *  so a tenant at a limit sees exactly one. */
  showSafetyLink?: boolean;
}) {
  if (gate.status === 'allowed') return null;
  if (gate.status === 'loading') {
    return (
      <p id="new-request-gate" data-testid="creation-gate-loading" className={`text-sm text-slate-500 in-[.lichen-d5]:text-meta ${className}`} aria-live="polite">
        Checking whether you can start a new request…
      </p>
    );
  }
  if (gate.status === 'error') {
    return (
      <div
        id="new-request-gate"
        role="alert"
        data-testid="creation-gate-error"
        className={`flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-alert-line in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text ${className}`}
      >
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">We couldn&rsquo;t check your request limits, so New Request is paused.</span>
        <Button size="sm" variant="outline" className="gap-1.5 border-amber-300 bg-white in-[.lichen-d5]:bg-card in-[.lichen-d5]:border-control-border in-[.lichen-d5]:text-ink" onClick={onRetry} data-testid="creation-gate-retry">
          <RotateCcw className="h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }
  return (
    <div
      id="new-request-gate"
      data-testid="creation-gate-blocked"
      data-reasons={gate.reasons.join(',')}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-well in-[.lichen-d5]:text-ink ${className}`}
    >
      <span className="min-w-0 flex-1">{gate.message}</span>
      {showSafetyLink && !gate.reasons.includes('unit_unlinked') ? <SafetyConcernLink /> : null}
    </div>
  );
}
