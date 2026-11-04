import { D3DialogContent } from './request-detail/d3Presentation';
import { D3_FIELD } from './request-detail/d3Presentation';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, RotateCcw, Send, XCircle } from 'lucide-react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Textarea } from './ui/textarea';
import RequestIdentity from './landlord/RequestIdentity';

export interface RejectRequestTarget {
  requestId: string;
  issueTitle: string;
  /** The request already had its one appeal: rejecting it now is final and
   *  removes it (appeal.rejectIsFinal from the server). */
  final?: boolean;
}

export interface ApproveContactTarget {
  requestId: string;
  issueTitle: string;
  candidateKey: string;
  vendorName: string;
  draftMessage: string;
  /** Masked vendor address, e.g. "exc***@gmail.com". Optional so callers that
   *  don't have the candidate's contact block still compile. */
  vendorEmailMasked?: string | null;
  /** False when the vendor has no email on file — outreach cannot be sent. */
  vendorHasEmail?: boolean;
  /** Human SLA label derived from request severity, e.g. "4 business hours". */
  responseSlaLabel?: string | null;
  /** Live send timing from the server. When `sendNow` is false the vendor is
   *  closed and the only option is a send scheduled for their next opening. */
  sendTiming?: { sendNow: boolean; scheduledForLabel?: string | null; hoursLabel?: string | null } | null;
  /** Likely windows the vendor will be offered (immediate sends only). */
  offerPreview?: string[];
}

const eyebrow = 'text-[11px] font-semibold uppercase tracking-[0.14em]';

export function RejectRequestDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: RejectRequestTarget | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    setReason('');
  }, [target?.requestId]);

  const normalizedReason = reason.trim();

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && !busy && onClose()}>
      <D3DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 overflow-hidden p-0">
        <div className="h-1 w-full shrink-0 bg-gradient-to-r in-[.lichen-d3]:hidden from-rose-500 to-orange-400" />
        <DialogHeader className="shrink-0 px-6 pt-6">
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-600 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text">
              <XCircle className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-slate-900 in-[.lichen-d3]:text-ink">
                {target?.final ? 'Reject this request for good?' : 'Reject this maintenance request?'}
              </DialogTitle>
              <DialogDescription className="mt-1 text-slate-500 in-[.lichen-d3]:text-meta">
                {target?.final
                  ? 'This is final. The request is removed for you and the tenant.'
                  : 'This closes the request and sends your explanation to the tenant.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
              <div className={`${eyebrow} text-slate-400 in-[.lichen-d3]:text-meta`}>Request</div>
              <div className="mt-1 text-sm font-medium text-slate-900 in-[.lichen-d3]:text-ink">{target?.issueTitle}</div>
            </div>
            <div>
              <label htmlFor="request-rejection-reason" className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
                Explanation for the tenant
              </label>
              <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                Required. Be specific and explain what the tenant should do next, when applicable.
              </p>
              <Textarea
                id="request-rejection-reason"
                data-testid="request-rejection-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                rows={5}
                className={["mt-3 border-slate-200 bg-white focus-visible:border-rose-400 focus-visible:ring-rose-400/15 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:focus-visible:border-alert-line", D3_FIELD].join(' ')}
                placeholder="Explain why this request is being rejected..."
                disabled={busy}
              />
              <div className="mt-1 text-right text-[11px] text-slate-400 in-[.lichen-d3]:text-meta">{reason.length}/1000</div>
            </div>
            {target?.final ? (
              <div
                className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs leading-5 text-rose-800 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text"
                data-testid="request-rejection-final-warning"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500 in-[.lichen-d3]:text-alert-text" />
                The tenant already used their appeal on this request. This rejection is final: the request is
                removed from both portals and the tenant is sent your explanation with their next steps.
              </div>
            ) : (
              <div className="flex gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-800 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500 in-[.lichen-d3]:text-lichen-text" />
                The tenant has 48 hours to appeal once. Without an appeal, the request is removed when the window
                closes.
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4 in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
          <Button variant="outline" className="border-slate-200 bg-white in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card" onClick={onClose} disabled={busy}>
            Keep Request Open
          </Button>
          <Button
            data-testid="confirm-request-rejection"
            className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700 in-[.lichen-d3]:bg-destructive in-[.lichen-d3]:hover:bg-destructive/90 in-[.lichen-d3]:text-destructive-foreground"
            disabled={busy || !normalizedReason}
            onClick={() => onConfirm(normalizedReason)}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            {target?.final ? 'Reject for Good' : 'Reject Request'}
          </Button>
        </DialogFooter>
      </D3DialogContent>
    </Dialog>
  );
}

export interface AppealDecisionTarget {
  requestId: string;
  issueTitle: string;
  rejectionReason?: string | null;
  /** The tenant's appeal; absent when withdrawing a rejection nobody appealed. */
  appealNote?: string | null;
}

/**
 * Accept the tenant's appeal, or withdraw a rejection nobody has appealed yet.
 * Both put the request back in the queue with fresh routing.
 */
export function ReopenRequestDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: AppealDecisionTarget | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  useEffect(() => {
    setNote('');
  }, [target?.requestId]);
  const isAppeal = Boolean(target?.appealNote);

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && !busy && onClose()}>
      <D3DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 overflow-hidden p-0">
        <div className="h-1 w-full shrink-0 bg-gradient-to-r in-[.lichen-d3]:hidden from-emerald-500 to-[#137fec]" />
        <DialogHeader className="shrink-0 px-6 pt-6">
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text">
              <RotateCcw className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-slate-900 in-[.lichen-d3]:text-ink">
                {isAppeal ? 'Accept the appeal and reopen?' : 'Withdraw this rejection?'}
              </DialogTitle>
              <DialogDescription className="mt-1 text-slate-500 in-[.lichen-d3]:text-meta">
                The request goes back in the queue with a fresh history, and the tenant is told.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
              <div className={`${eyebrow} text-slate-400 in-[.lichen-d3]:text-meta`}>Request</div>
              <div className="mt-1 text-sm font-medium text-slate-900 in-[.lichen-d3]:text-ink">{target?.issueTitle}</div>
            </div>
            {target?.appealNote ? (
              <div className="rounded-xl border border-fuchsia-100 bg-fuchsia-50/60 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint">
                <div className={`${eyebrow} text-fuchsia-700 in-[.lichen-d3]:text-lichen-text`}>Tenant&rsquo;s appeal</div>
                <div className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-700 in-[.lichen-d3]:text-ink">{target.appealNote}</div>
              </div>
            ) : null}
            <div>
              <label htmlFor="reopen-note" className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
                Note for the request history
              </label>
              <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">Optional.</p>
              <Textarea
                id="reopen-note"
                data-testid="reopen-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
                rows={3}
                className={["mt-3 border-slate-200 bg-white in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card", D3_FIELD].join(' ')}
                placeholder={isAppeal ? 'e.g. Photos show it is the building pipe.' : 'e.g. Rejected by mistake.'}
                disabled={busy}
              />
            </div>
            <p className="text-xs leading-5 text-slate-500 in-[.lichen-d3]:text-meta">
              Reopening doesn&rsquo;t use another of the tenant&rsquo;s requests.
              {isAppeal ? ' The tenant has now used their one appeal, so a later rejection would be final.' : ''}
            </p>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4 in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
          <Button variant="outline" className="border-slate-200 bg-white in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            data-testid="confirm-reopen-request"
            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
            disabled={busy}
            onClick={() => onConfirm(note.trim())}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            {isAppeal ? 'Accept & Reopen' : 'Withdraw Rejection'}
          </Button>
        </DialogFooter>
      </D3DialogContent>
    </Dialog>
  );
}

/** Decline the tenant's appeal: final, and the request is removed for both sides. */
export function DeclineAppealDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: AppealDecisionTarget | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    setReason('');
  }, [target?.requestId]);
  const normalizedReason = reason.trim();

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && !busy && onClose()}>
      <D3DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 overflow-hidden p-0">
        <div className="h-1 w-full shrink-0 bg-gradient-to-r in-[.lichen-d3]:hidden from-rose-500 to-orange-400" />
        <DialogHeader className="shrink-0 px-6 pt-6">
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-600 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text">
              <XCircle className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-slate-900 in-[.lichen-d3]:text-ink">Decline the appeal?</DialogTitle>
              <DialogDescription className="mt-1 text-slate-500 in-[.lichen-d3]:text-meta">
                This is final. The request is removed for you and the tenant.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
              <div className={`${eyebrow} text-slate-400 in-[.lichen-d3]:text-meta`}>Request</div>
              <div className="mt-1 text-sm font-medium text-slate-900 in-[.lichen-d3]:text-ink">{target?.issueTitle}</div>
            </div>
            {target?.appealNote ? (
              <div className="rounded-xl border border-fuchsia-100 bg-fuchsia-50/60 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint">
                <div className={`${eyebrow} text-fuchsia-700 in-[.lichen-d3]:text-lichen-text`}>Tenant&rsquo;s appeal</div>
                <div className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-700 in-[.lichen-d3]:text-ink">{target.appealNote}</div>
              </div>
            ) : null}
            <div>
              <label htmlFor="decline-appeal-reason" className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
                Why the decision stands
              </label>
              <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                Required. The tenant receives this with their next steps, so answer their appeal directly.
              </p>
              <Textarea
                id="decline-appeal-reason"
                data-testid="decline-appeal-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                rows={5}
                className={["mt-3 border-slate-200 bg-white focus-visible:border-rose-400 focus-visible:ring-rose-400/15 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:focus-visible:border-alert-line", D3_FIELD].join(' ')}
                placeholder="Explain why the rejection stands..."
                disabled={busy}
              />
              <div className="mt-1 text-right text-[11px] text-slate-400 in-[.lichen-d3]:text-meta">{reason.length}/1000</div>
            </div>
            <div className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs leading-5 text-rose-800 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500 in-[.lichen-d3]:text-alert-text" />
              The request disappears from both portals and can&rsquo;t be appealed again. The tenant can still send a
              new request about the issue; it counts toward their request limits.
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4 in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
          <Button variant="outline" className="border-slate-200 bg-white in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            data-testid="confirm-decline-appeal"
            className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700 in-[.lichen-d3]:bg-destructive in-[.lichen-d3]:hover:bg-destructive/90 in-[.lichen-d3]:text-destructive-foreground"
            disabled={busy || !normalizedReason}
            onClick={() => onConfirm(normalizedReason)}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            Decline Appeal
          </Button>
        </DialogFooter>
      </D3DialogContent>
    </Dialog>
  );
}

export interface CompleteRequestTarget {
  requestId: string;
  issueTitle: string;
  /** The vendor's agreed quote, used to prefill. It is an estimate — the
   *  landlord confirms what was actually paid. */
  suggestedCost?: number | null;
  vendorName?: string | null;
}

/**
 * Captures the final cost on completion.
 *
 * This replaces a raw `window.prompt`, which was dismissible — cancelling
 * returned null and the cost was silently dropped. Since reported spend counts
 * only completed work, a missing final cost meant the figure never moved.
 */
export function CompleteRequestDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: CompleteRequestTarget | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (finalCost: number, notes: string) => Promise<void>;
}) {
  const [finalCost, setFinalCost] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    setFinalCost(target?.suggestedCost != null ? String(target.suggestedCost) : '');
    setNotes('');
  }, [target?.requestId, target?.suggestedCost]);

  const parsed = Number(finalCost);
  const valid = finalCost.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && !busy && onClose()}>
      <D3DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 overflow-hidden p-0">
        <div className="h-1 w-full shrink-0 bg-gradient-to-r in-[.lichen-d3]:hidden from-emerald-500 to-teal-400" />
        <DialogHeader className="shrink-0 px-6 pt-6">
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-slate-900 in-[.lichen-d3]:text-ink">Complete request</DialogTitle>
              <DialogDescription className="mt-1 text-slate-500 in-[.lichen-d3]:text-meta">
                Record what this job actually cost. This is the figure that counts toward your
                reported maintenance spend.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
            <div className={`${eyebrow} text-slate-400 in-[.lichen-d3]:text-meta`}>Request</div>
            <div className="mt-1 text-sm font-medium text-slate-900 in-[.lichen-d3]:text-ink">{target?.issueTitle}</div>
            {target ? <RequestIdentity id={target.requestId} /> : null}
          </div>

          <label className="mt-4 block">
            <span className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">Final cost</span>
            {target?.suggestedCost != null ? (
              <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                {target.vendorName ? `${target.vendorName} quoted ` : 'Quoted '}
                ${target.suggestedCost.toLocaleString()}. Adjust if the invoice differs.
              </p>
            ) : (
              <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                Enter 0 if the work was covered by warranty or goodwill.
              </p>
            )}
            <div className="relative mt-2">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 in-[.lichen-d3]:text-meta">
                $
              </span>
              <input
                type="number"
                min={0}
                inputMode="decimal"
                value={finalCost}
                onChange={(event) => setFinalCost(event.target.value)}
                placeholder="0.00"
                disabled={busy}
                data-testid="complete-final-cost"
                className={["h-10 w-full rounded-lg border border-slate-200 bg-white pl-7 pr-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink in-[.lichen-d3]:shadow-none in-[.lichen-d3]:focus:border-mist-line", D3_FIELD].join(' ')}
              />
            </div>
          </label>

          <label className="mt-4 block">
            <span className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">Completion notes</span>
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="What was done, parts replaced, anything to follow up…"
              className={["mt-2 border-slate-200 bg-white in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card", D3_FIELD].join(' ')}
              disabled={busy}
              data-testid="complete-notes"
            />
          </label>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4 in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
          <Button variant="outline" className="border-slate-200 bg-white in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            data-testid="confirm-complete-request"
            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
            disabled={busy || !valid}
            onClick={() => onConfirm(parsed, notes.trim())}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Mark Complete
          </Button>
        </DialogFooter>
      </D3DialogContent>
    </Dialog>
  );
}

export function ApproveContactDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: ApproveContactTarget | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (draftMessage: string) => Promise<void>;
}) {
  const [draftMessage, setDraftMessage] = useState('');

  useEffect(() => {
    setDraftMessage(target?.draftMessage || '');
  }, [target?.candidateKey, target?.draftMessage]);

  const normalizedDraft = draftMessage.trim();
  // Standard/low jobs to a vendor who is closed right now go out at their next
  // opening -- like scheduling an email -- and there's no "send now" override.
  // The server makes the same call on approve, so this only explains it.
  const scheduled = target?.sendTiming?.sendNow === false;
  const scheduledLabel = target?.sendTiming?.scheduledForLabel || 'their next opening';

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && !busy && onClose()}>
      <D3DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <div className="h-1 w-full shrink-0 bg-gradient-to-r in-[.lichen-d3]:hidden from-emerald-500 to-cyan-500" />
        <DialogHeader className="shrink-0 px-6 pt-6">
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text">
              <Send className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-slate-900 in-[.lichen-d3]:text-ink">Approve vendor contact</DialogTitle>
              <DialogDescription className="mt-1 text-slate-500 in-[.lichen-d3]:text-meta">
                Review the selected vendor and outreach draft before approving contact.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
                <div className={`${eyebrow} text-slate-400 in-[.lichen-d3]:text-meta`}>Request</div>
                <div className="mt-1 text-sm font-medium text-slate-900 in-[.lichen-d3]:text-ink">{target?.issueTitle}</div>
                {target ? <RequestIdentity id={target.requestId} /> : null}
              </div>
              <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-mist-line in-[.lichen-d3]:bg-mist-tint">
                <div className={`${eyebrow} text-emerald-700 in-[.lichen-d3]:text-mist-text`}>Vendor to contact</div>
                <div className="mt-1 text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{target?.vendorName}</div>
              </div>
            </div>
            {target && target.vendorHasEmail === false ? (
              <div
                className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text"
                data-testid="approve-contact-no-email"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong>{target.vendorName}</strong> has no email address on file, so Artrelo
                  can&rsquo;t send the outreach. Add one on the Vendors page, or assign this vendor
                  manually and contact them yourself.
                </span>
              </div>
            ) : target?.vendorEmailMasked ? (
              <div
                className="flex items-start gap-2 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-900 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink"
                data-testid="approve-contact-outreach-notice"
              >
                <Send className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  On approval Artrelo emails{' '}
                  <strong className="whitespace-nowrap">{target.vendorEmailMasked}</strong> a secure
                  link to accept or decline
                  {target.responseSlaLabel ? (
                    <>
                      , with a response expected within{' '}
                      <strong>{target.responseSlaLabel}</strong>
                    </>
                  ) : null}
                  . The unit and tenant details stay hidden until they accept.
                </span>
              </div>
            ) : null}
            {!scheduled && target?.offerPreview?.length ? (
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 text-sm text-slate-600 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-meta">
                <div className={`${eyebrow} text-slate-400 in-[.lichen-d3]:text-meta`}>Times they&rsquo;ll be offered</div>
                <div className="mt-1">{target.offerPreview.join(' · ')}</div>
              </div>
            ) : null}
            {scheduled ? (
              <div
                className="flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text"
                data-testid="approve-contact-scheduled-notice"
              >
                <Clock className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong>{target?.vendorName}</strong> is closed right now
                  {target?.sendTiming?.hoursLabel ? ` (hours: ${target.sendTiming.hoursLabel})` : ''}. The
                  outreach will be sent when they open, on <strong>{scheduledLabel}</strong>, and their
                  response time starts then. You can cancel it any time before it goes out.
                </span>
              </div>
            ) : null}

            <div>
              <label htmlFor="vendor-contact-draft" className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
                Outreach draft
              </label>
              <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                This is sent to the vendor as-is. Keep the unit number and tenant name out of it —
                those are revealed only after they accept.
              </p>
              <Textarea
                id="vendor-contact-draft"
                data-testid="vendor-contact-draft"
                value={draftMessage}
                onChange={(event) => setDraftMessage(event.target.value)}
                maxLength={4000}
                rows={6}
                className={["mt-3 max-h-[32vh] border-slate-200 bg-white focus-visible:border-emerald-500 focus-visible:ring-emerald-500/15 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:focus-visible:border-mist-line", D3_FIELD].join(' ')}
                disabled={busy}
              />
              <div className="mt-1 text-right text-[11px] text-slate-400 in-[.lichen-d3]:text-meta">{draftMessage.length}/4000</div>
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4 in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
          <Button variant="outline" className="border-slate-200 bg-white in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            data-testid="confirm-approve-contact"
            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
            disabled={busy || !normalizedDraft}
            onClick={() => onConfirm(normalizedDraft)}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : scheduled ? (
              <Clock className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {scheduled ? `Schedule send · ${scheduledLabel}` : 'Approve Contact'}
          </Button>
        </DialogFooter>
      </D3DialogContent>
    </Dialog>
  );
}

export type DismissQuoteTarget = { outreachId: string; vendorName: string; candidateKey: string };

/**
 * Turning down a quote the vendor already accepted with. They said yes and are
 * holding a time window, so they are emailed; the reason, if given, goes with
 * it. Optional -- a polite email goes either way -- and never includes the
 * quota, which stays between the manager and Artrelo.
 */
export function DismissQuoteDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: DismissQuoteTarget | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    setReason('');
  }, [target?.outreachId]);

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && !busy && onClose()}>
      <D3DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 overflow-hidden p-0" data-testid="dismiss-quote-dialog">
        <div className="h-1 w-full shrink-0 bg-gradient-to-r in-[.lichen-d3]:hidden from-rose-500 to-orange-400" />
        <DialogHeader className="shrink-0 px-6 pt-6">
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-600 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text">
              <XCircle className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-slate-900 in-[.lichen-d3]:text-ink">Turn down {target?.vendorName}&rsquo;s quote?</DialogTitle>
              <DialogDescription className="mt-1 text-slate-500 in-[.lichen-d3]:text-meta">
                We&rsquo;ll email them that you&rsquo;re not going ahead, then move this request to the next
                vendor in line.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <label htmlFor="dismiss-quote-reason" className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
            Reason for the vendor
          </label>
          <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
            Optional, and shared with the vendor as written. Your spending limit is never shared.
          </p>
          <Textarea
            id="dismiss-quote-reason"
            data-testid="dismiss-quote-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={4}
            className={["mt-3 border-slate-200 bg-white focus-visible:border-rose-400 focus-visible:ring-rose-400/15 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:focus-visible:border-alert-line", D3_FIELD].join(' ')}
            placeholder="e.g. We've gone with a quote closer to our budget."
            disabled={busy}
          />
          <div className="mt-1 text-right text-[11px] text-slate-400 in-[.lichen-d3]:text-meta">{reason.length}/500</div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4 in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
          <Button variant="outline" className="border-slate-200 bg-white in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card" onClick={onClose} disabled={busy}>
            Keep this quote
          </Button>
          <Button
            data-testid="confirm-dismiss-quote"
            className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700 in-[.lichen-d3]:bg-destructive in-[.lichen-d3]:hover:bg-destructive/90 in-[.lichen-d3]:text-destructive-foreground"
            disabled={busy}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            Turn down quote
          </Button>
        </DialogFooter>
      </D3DialogContent>
    </Dialog>
  );
}
