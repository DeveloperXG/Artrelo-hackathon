import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  Banknote,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Loader2,
  MapPin,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, VendorPortalAPI } from '../../api/client';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import ItemizationEditor, { quoteFieldClass } from '../../components/quotes/ItemizationEditor';
import ItemizationBreakdown from '../../components/quotes/ItemizationBreakdown';
import { FieldError, invalidFieldClass } from '../../components/ui/FieldError';
import {
  MAX_INVOICE_REFERENCE,
  emptyLine,
  itemizationErrorMessage,
  lineErrorFromServer,
  type DraftLine,
  type Itemization,
  type LineErrors,
} from '../../lib/itemization';
import { buildFinalStatement } from './finalStatement';

/**
 * The vendor's post-visit surface: "here's what I did, here's the cost".
 *
 * Reached with the JOB-scoped token minted at acceptance — not the outreach
 * token, which is scoped to the offer. No login: the token is the credential.
 */

type CompletionPhoto = { url: string; label?: string | null; stage: string };
type CompletionView = {
  status: string;
  /** 2 when this job runs under the itemized quote contract: the report then
   *  needs a fixed, line-by-line final statement. */
  quoteContractVersion?: 2;
  photos: CompletionPhoto[];
  photoCount: number;
  maxPhotos: number;
  checkedIn: boolean;
  awaitingTenant: boolean;
  autoConfirmAt?: string | null;
  report?: {
    workPerformed: string;
    actualCost: number | null;
    submittedAt: string;
    /** The submitted final statement. Immutable once sent. */
    itemization?: Itemization | null;
    invoiceReference?: string | null;
  } | null;
  /** Set when the submitted cost is above the approved amount and the close is
   *  held. Status only — the server never sends the figure or the overage. */
  costReview?: {
    status: 'pending' | 'approved' | 'rejected';
    /** What the manager authorized — present only once approved. It can be
     *  LESS than the vendor invoiced, and it is what they will be paid. */
    approvedAmount?: number | null;
  } | null;
};

export default function VendorJobPage() {
  const { token = '' } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [completion, setCompletion] = useState<CompletionView | null>(null);
  const [jobReference, setJobReference] = useState('');

  const [workPerformed, setWorkPerformed] = useState('');
  const [partsUsed, setPartsUsed] = useState('');
  const [actualCost, setActualCost] = useState('');
  const [followUpNeeded, setFollowUpNeeded] = useState(false);
  const [followUpNotes, setFollowUpNotes] = useState('');
  // Revealed reactively, only after the server rejects the cost as over the
  // approved amount. Never shown pre-emptively.
  const [overageReason, setOverageReason] = useState('');
  const [needsOverageReason, setNeedsOverageReason] = useState(false);
  // Itemized jobs: the final statement replaces the single cost box, and the
  // cost sent is its total -- never a second number that could disagree.
  const [finalLines, setFinalLines] = useState<DraftLine[]>(() => [emptyLine()]);
  const [finalLineErrors, setFinalLineErrors] = useState<Record<string, LineErrors>>({});
  const [invoiceReference, setInvoiceReference] = useState('');
  const [statementError, setStatementError] = useState('');
  // Payout setup. Shown whether or not the report is submitted — a vendor who
  // has already finished the work still needs somewhere to enter bank details,
  // and that was the case with no route through the product at all.
  const [payoutStatus, setPayoutStatus] = useState<string>('none');
  const [payoutSupported, setPayoutSupported] = useState(false);
  // Set up on an earlier job (for any landlord): remind them, and let them change it.
  // Set when the property manager pays this vendor directly: no payout setup,
  // just a line saying who pays.
  const [directPayNote, setDirectPayNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await VendorPortalAPI.getCompletion(token);
      const data = res.data as { completion: CompletionView; jobReference: string };
      setCompletion(data.completion);
      setJobReference(data.jobReference);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This link is not valid.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const res = await VendorPortalAPI.getPayoutStatus(token);
        const data = res.data as {
          supported: boolean;
          status: string;
          canUpdate?: boolean;
          reason?: string;
          message?: string;
        };
        setDirectPayNote(data?.reason === 'direct_pay' ? data.message || '' : '');
        setPayoutSupported(Boolean(data?.supported));
        setPayoutStatus(data?.status || 'none');
      } catch {
        // Payout setup being unavailable must never block the completion form —
        // the vendor can still submit and be paid manually.
        setPayoutSupported(false);
      }
    })();
  }, [token]);

  /**
   * Arrival ping. A refusal is RECORDED, not treated as an error — the vendor
   * did the work whether or not their browser let us look, and blocking here
   * would strand real jobs. It just means a human reviews the completion.
   */
  const checkIn = () => {
    if (!navigator.geolocation) {
      void VendorPortalAPI.recordCheckpoint(token, { kind: 'checkIn', denied: true }).then(load);
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          await VendorPortalAPI.recordCheckpoint(token, {
            kind: 'checkIn',
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracyMeters: position.coords.accuracy,
          });
          toast.success('Arrival recorded.');
          await load();
        } catch {
          toast.error('Could not record your arrival.');
        } finally {
          setBusy(false);
        }
      },
      async () => {
        try {
          await VendorPortalAPI.recordCheckpoint(token, { kind: 'checkIn', denied: true });
          toast.message('No location shared — your manager will review the photos instead.');
          await load();
        } finally {
          setBusy(false);
        }
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const res = await VendorPortalAPI.uploadCompletionPhoto(token, file, { stage: 'after' });
      setCompletion(res.data as CompletionView);
      toast.success('Photo added.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not upload that photo.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const itemized = completion?.quoteContractVersion === 2;

  const submit = async () => {
    const cost = Number(actualCost);
    if (workPerformed.trim().length < 10) {
      toast.error('Please describe the work you carried out.');
      return;
    }
    const statement = itemized ? buildFinalStatement(finalLines, invoiceReference) : null;
    if (statement && !statement.ok) {
      setFinalLineErrors(statement.lineErrors);
      setStatementError(statement.message);
      return;
    }
    if (!statement && (!Number.isFinite(cost) || cost < 0)) {
      toast.error('Enter the final cost for this job.');
      return;
    }
    if (needsOverageReason && !overageReason.trim()) {
      toast.error('Please add a short note explaining the cost.');
      return;
    }
    setBusy(true);
    try {
      const res = await VendorPortalAPI.submitCompletion(token, {
        workPerformed: workPerformed.trim(),
        partsUsed: partsUsed.trim(),
        followUpNeeded,
        followUpNotes: followUpNotes.trim(),
        actualCost: cost,
        overageReason: overageReason.trim() || undefined,
        // Itemized: actualCost is replaced by the statement's exact total.
        ...(statement?.ok ? statement.fields : {}),
      });
      setCompletion(res.data as CompletionView);
      setNeedsOverageReason(false);
      setStatementError('');
      toast.success('Submitted — thanks!');
    } catch (err) {
      const apiError = err as ApiError;
      const body = apiError.payload as { code?: string; message?: string } | undefined;
      // The cost is above the approved amount. The server tells us only THAT,
      // never the figure — asking up front would anchor the vendor to the
      // ceiling, and a checkable endpoint would let them binary-search it.
      const fieldBody = body as { code?: string; field?: string } | undefined;
      if (body?.code === 'overage_reason_required') {
        setNeedsOverageReason(true);
        toast.info(body.message || 'Please explain the cost before submitting.');
      } else if (!itemized && apiError.status === 409 && body?.code === 'quote_revision_conflict') {
        // The job turned out to need an itemized statement (this submit is
        // what created its draft). Reload to show that form; the description
        // fields keep what was typed.
        toast.info('This job needs an itemized final statement. Add your charges line by line.');
        await load();
      } else if (itemized && apiError.status === 400 && fieldBody?.code) {
        const target = lineErrorFromServer(fieldBody.field, finalLines, 'fixed');
        const message = itemizationErrorMessage(fieldBody.code);
        if (target) setFinalLineErrors({ [target.key]: { [target.field]: message } });
        setStatementError(message);
      } else {
        toast.error(body?.message || apiError.message || 'Could not submit your report.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-6 w-6 animate-spin text-[#137fec]" aria-hidden="true" />
      </main>
    );
  }

  if (error || !completion) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <AlertCircle className="mx-auto h-8 w-8 text-slate-400" aria-hidden="true" />
          <h1 className="mt-4 text-lg font-semibold text-slate-900">This link is not valid</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {error || 'It may have been replaced by a newer one.'}
          </p>
        </div>
      </main>
    );
  }

  const submitted = Boolean(completion.report?.submittedAt);
  // A held close leaves status at `awaiting_tenant` with a stale autoConfirmAt,
  // so this must be checked BEFORE awaitingTenant or the page tells the vendor
  // it is waiting on the tenant when it is really waiting on the manager.
  const costReview = completion.costReview;
  const costHeld = costReview?.status === 'pending';

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            <ClipboardCheck className="h-4 w-4 text-[#137fec]" aria-hidden="true" />
            {jobReference}
          </div>
          <h1 className="mt-2 text-xl font-semibold text-slate-900">
            {submitted ? 'Report submitted' : 'Finish this job'}
          </h1>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {!submitted
              ? 'Add a photo of the finished work and the final cost.'
              : costHeld
                ? 'Your final cost is with the property manager for approval.'
                : completion.awaitingTenant
                  ? 'The tenant has been asked to confirm the work. You’ll be paid once they do.'
                  : 'Your property manager is reviewing this one and will be in touch.'}
          </p>
        </header>

        {/* Why the job hasn't closed. Without this the page reads "awaiting
            tenant" indefinitely, with a confirmation deadline already in the
            past — which looks like the submission was lost. */}
        {costReview ? (
          <section
            className={`rounded-2xl border p-5 shadow-sm ${
              costReview.status === 'pending'
                ? 'border-amber-200 bg-amber-50'
                : costReview.status === 'approved'
                  ? 'border-emerald-200 bg-emerald-50'
                  : 'border-rose-200 bg-rose-50'
            }`}
            data-testid={`vendor-cost-review-${costReview.status}`}
          >
            <div className="flex items-start gap-2">
              {costReview.status === 'pending' ? (
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              ) : costReview.status === 'approved' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
              )}
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  {costReview.status === 'pending'
                    ? 'Waiting on cost approval'
                    : costReview.status === 'approved'
                      ? // Name the figure. A manager can approve LESS than was
                        // invoiced, and "Cost approved" beside the original
                        // number gave no hint the payout would differ.
                        typeof costReview.approvedAmount === 'number'
                        ? `Cost approved at $${costReview.approvedAmount}`
                        : 'Cost approved'
                      : 'Cost not approved'}
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-700">
                  {costReview.status === 'pending'
                    ? 'Your final cost came in above the amount approved for this job, so it needs the property manager to sign off before the job can close. Nothing more is needed from you — we’ll email you when they decide.'
                    : costReview.status === 'approved'
                      ? typeof costReview.approvedAmount === 'number'
                        ? `The property manager authorized $${costReview.approvedAmount} for this job, and that is what you'll be paid. This job is closing out now.`
                        : 'The property manager approved your final cost. This job is closing out now.'
                      : 'The property manager did not approve the final cost. They’ll be in touch to settle this one directly.'}
                </p>
              </div>
            </div>
          </section>
        ) : null}

        {directPayNote ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-5" data-testid="vendor-direct-pay">
            <div className="flex items-start gap-2">
              <Banknote className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-slate-900">Getting paid</h2>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  {directPayNote} There&rsquo;s nothing to set up here.
                </p>
              </div>
            </div>
          </section>
        ) : null}

        {payoutSupported ? (
          <section className="rounded-2xl border border-sky-200 bg-sky-50 p-5" data-testid="vendor-payout-setup">
            <h2 className="text-sm font-semibold text-slate-900">Getting paid</h2>
            <p className="mt-1 text-sm text-slate-600">
              {payoutStatus === 'enabled'
                ? 'Your payout account is set up. Sign in to your vendor hub to manage it.'
                : 'Sign in to your vendor hub to add your bank details. We will email you a secure sign-in link.'}
            </p>
            <Link to="/vendor-hub/sign-in" className="mt-3 inline-block text-sm font-medium text-blue-700 underline" data-testid="vendor-payout-hub">
              Open vendor hub
            </Link>
          </section>
        ) : null}

        {!submitted ? (
          <>
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">On site</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Optional. Sharing your location when you arrive helps confirm the visit — if you
                skip it, your manager just reviews the photos instead.
              </p>
              <Button
                variant="outline"
                onClick={checkIn}
                disabled={busy || completion.checkedIn}
                className="mt-3 gap-1.5 border-slate-200"
                data-testid="vendor-checkin"
              >
                <MapPin className="h-4 w-4" aria-hidden="true" />
                {completion.checkedIn ? 'Arrival recorded' : 'Record my arrival'}
              </Button>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">
                Photos of the finished work
                <span className="ml-1 font-normal text-slate-400">
                  ({completion.photoCount}/{completion.maxPhotos})
                </span>
              </h2>

              {completion.photos.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {completion.photos.map((photo) => (
                    <div
                      key={photo.url}
                      className="h-20 w-20 overflow-hidden rounded-lg border border-slate-200"
                    >
                      <img
                        src={photo.url}
                        alt={photo.label || 'Completed work'}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  ))}
                </div>
              ) : null}

              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
                data-testid="vendor-photo-input"
              />
              <Button
                variant="outline"
                onClick={() => fileInput.current?.click()}
                disabled={uploading || completion.photoCount >= completion.maxPhotos}
                className="mt-3 gap-1.5 border-slate-200"
                data-testid="vendor-photo-add"
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Camera className="h-4 w-4" aria-hidden="true" />
                )}
                Add a photo
              </Button>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">What you did</h2>

              <label className="mt-3 block text-xs font-medium text-slate-600">
                Work carried out
              </label>
              <Textarea
                value={workPerformed}
                onChange={(event) => setWorkPerformed(event.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Replaced the P-trap and resealed the basin waste…"
                className="mt-1.5 border-slate-200 bg-white"
                data-testid="vendor-work-performed"
              />

              <label className="mt-4 block text-xs font-medium text-slate-600">
                Parts used (optional)
              </label>
              <Input
                value={partsUsed}
                onChange={(event) => setPartsUsed(event.target.value)}
                maxLength={1000}
                placeholder="1x P-trap, plumber's putty"
                className="mt-1.5 border-slate-200 bg-white"
                data-testid="vendor-parts-used"
              />

              {itemized ? (
                <div className="mt-5" data-testid="vendor-final-statement">
                  <h3 className="text-sm font-semibold text-slate-900">Final charges</h3>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    One line per charge, as exact amounts in CAD. Once submitted, this statement can&rsquo;t be
                    changed.
                  </p>
                  <div className="mt-3">
                    <ItemizationEditor
                      idPrefix="vendor-final"
                      mode="fixed"
                      lines={finalLines}
                      onLinesChange={(lines) => {
                        setFinalLines(lines);
                        setStatementError('');
                      }}
                      lineErrors={finalLineErrors}
                      onClearError={(key, field) =>
                        setFinalLineErrors((current) =>
                          current[key]?.[field] ? { ...current, [key]: { ...current[key], [field]: undefined } } : current
                        )
                      }
                      disabled={busy}
                      totalLabel="Final total"
                    />
                  </div>
                  <label className="mt-4 block text-xs font-medium text-slate-600" htmlFor="vendor-invoice-reference">
                    Your invoice number (optional)
                  </label>
                  <input
                    id="vendor-invoice-reference"
                    type="text"
                    value={invoiceReference}
                    maxLength={MAX_INVOICE_REFERENCE}
                    onChange={(event) => setInvoiceReference(event.target.value)}
                    placeholder="INV-1042"
                    className={`${quoteFieldClass} mt-1.5 ${
                      invoiceReference.trim().length > MAX_INVOICE_REFERENCE ? invalidFieldClass : ''
                    }`}
                    data-testid="vendor-invoice-reference"
                  />
                  <FieldError id="vendor-final-statement-error" className="mt-2">
                    {statementError}
                  </FieldError>
                </div>
              ) : (
                <>
                  <label className="mt-4 block text-xs font-medium text-slate-600">
                    Final cost (CAD)
                  </label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    value={actualCost}
                    onChange={(event) => setActualCost(event.target.value)}
                    placeholder="240"
                    className={`mt-1.5 bg-white ${
                      needsOverageReason ? 'border-amber-300' : 'border-slate-200'
                    }`}
                    data-testid="vendor-actual-cost"
                  />
                </>
              )}

              {needsOverageReason ? (
                <div
                  className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3"
                  data-testid="vendor-overage-reason-block"
                >
                  <label
                    className="block text-xs font-semibold text-amber-900"
                    htmlFor="vendor-overage-reason"
                  >
                    This is above the amount approved for this job
                  </label>
                  <p className="mt-1 text-xs leading-5 text-amber-800">
                    Add a short note explaining why. Your property manager reviews it before the
                    job closes — the more specific you are, the faster that goes.
                  </p>
                  <Textarea
                    id="vendor-overage-reason"
                    rows={3}
                    value={overageReason}
                    onChange={(event) => setOverageReason(event.target.value)}
                    maxLength={1000}
                    placeholder="Found rot behind the panel — had to replace the section and add a new shut-off valve."
                    className="mt-2 border-amber-200 bg-white"
                    data-testid="vendor-overage-reason"
                  />
                </div>
              ) : null}

              <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={followUpNeeded}
                  onChange={(event) => setFollowUpNeeded(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-[#137fec]"
                  data-testid="vendor-follow-up"
                />
                More work is needed here
              </label>
              {followUpNeeded ? (
                <Textarea
                  value={followUpNotes}
                  onChange={(event) => setFollowUpNotes(event.target.value)}
                  rows={2}
                  maxLength={1000}
                  placeholder="The shutoff valve is seized and should be replaced…"
                  className="mt-2 border-slate-200 bg-white"
                />
              ) : null}

              {/* Submitting without a photo is allowed — a vendor with no signal
                  in a basement must not be stuck — but it costs them time, and
                  saying so up front is fairer than a silent delay. */}
              {completion.photoCount === 0 ? (
                <p
                  className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900"
                  data-testid="vendor-no-photo-warning"
                >
                  No photo attached. You can still submit, but your property manager will need to
                  review it by hand, which usually takes longer to get paid.
                </p>
              ) : null}

              <Button
                onClick={() => void submit()}
                disabled={busy}
                className="mt-5 w-full gap-1.5 bg-[#137fec] hover:bg-[#137fec]/90"
                data-testid="vendor-submit-completion"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                )}
                Submit report
              </Button>
            </section>
          </>
        ) : (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-6">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              ${completion.report?.actualCost} · submitted
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-700">
              {completion.report?.workPerformed}
            </p>
            {completion.report?.itemization ? (
              <div className="mt-4" data-testid="vendor-submitted-statement">
                <ItemizationBreakdown
                  itemization={completion.report.itemization}
                  title="Final statement"
                  caption={`${completion.report.invoiceReference ? `Invoice ${completion.report.invoiceReference} · ` : ''}as submitted, can’t be changed`}
                  testId="vendor-submitted-statement-breakdown"
                />
              </div>
            ) : null}
            {completion.photos.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {completion.photos.map((photo) => (
                  <div
                    key={photo.url}
                    className="h-16 w-16 overflow-hidden rounded-lg border border-slate-200"
                  >
                    <img src={photo.url} alt="" className="h-full w-full object-cover" />
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        )}
      </div>
    </main>
  );
}
