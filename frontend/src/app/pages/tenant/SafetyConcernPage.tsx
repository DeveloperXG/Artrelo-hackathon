import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Loader2, ShieldAlert } from 'lucide-react';
import { TenantAPI } from '../../api/client';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { FieldError, invalidFieldClass } from '../../components/ui/FieldError';
import { fieldClass } from '../../components/landlord/landlordUi';
import { useTenantMoveOut } from '../../hooks/tenant/useTenantMoveOut';
import { usePropertyManagerContact } from '../../hooks/tenant/usePropertyManagerContact';
import { useSubmissionKey } from '../../hooks/useSubmissionKey';
import { workflowConflict } from '../../lib/requestWorkflow';
import { TenantPage, TENANT_FIELD, useTenantPresentation } from '../../components/tenant/tenantPresentation';

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;

/**
 * A safety concern, separate from the normal request flow: no AI chat, no
 * daily/weekly or open-request limits (a linked unit is still required). The
 * server records it for urgent human review and contacts no vendor on its own.
 */
export default function SafetyConcernPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { linked } = useTenantMoveOut();
  const manager = usePropertyManagerContact();
  const carried = (location.state as { description?: string } | null)?.description || '';

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState(carried);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Same id for every retry of this one concern, so a double submit files
  // once; editing the text after a failure makes it a new submission.
  const submissionKey = useSubmissionKey();

  const titleError = touched && !title.trim() ? 'Say briefly what the concern is.' : null;
  const descriptionError = touched && !description.trim() ? 'Describe what is happening and where.' : null;
  const tenantPresentation = useTenantPresentation();
  const card = useRef<HTMLDivElement>(null);
  const submitFocus = useRef(false);
  useEffect(() => {
    if (!tenantPresentation || !submitFocus.current) return;
    const frame = requestAnimationFrame(() => {
      const current = document.activeElement;
      if (!document.querySelector('[role=dialog],[role=alertdialog]') &&
          (current === card.current || current === card.current?.querySelector('[data-testid=safety-submit]') ||
            [document.body, document.documentElement].includes(current as HTMLElement))) {
        const target = titleError ? '[data-testid=safety-title]' : descriptionError ? '[data-testid=safety-description]' :
          submitError ? '[data-testid=safety-submit]' : null;
        if (target) card.current?.querySelector<HTMLElement>(target)?.focus();
        else if (submitting) card.current?.focus();
      }
      if (!submitting) submitFocus.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [tenantPresentation, titleError, descriptionError, submitting, submitError]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!title.trim() || !description.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body = {
        issueTitle: title.trim(),
        issueDescription: description.trim(),
        source: 'form',
        runTriage: false,
        intakeMode: 'safety' as const,
        emergencyOverride: true,
      };
      const res = await TenantAPI.createRequest({ ...body, submissionId: submissionKey.idFor(body) });
      const id = (res.data as { _id?: string } | undefined)?._id;
      navigate(id ? `/portal/requests/${id}` : '/portal', { replace: true });
    } catch (e) {
      if (workflowConflict(e)?.code === 'idempotency_conflict') submissionKey.reset();
      setSubmitError(e instanceof Error ? e.message : 'Your safety concern was not sent.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!linked) {
    return (
      <TenantPage className="flex justify-center">
        <Button variant="outline" className="border-slate-200 in-[.lichen-d5]:border-border" onClick={() => navigate('/portal')}>
          Back to your requests
        </Button>
      </TenantPage>
    );
  }

  return (
    <TenantPage className="mx-auto w-full max-w-2xl py-4">
      <Card ref={card} tabIndex={tenantPresentation ? -1 : undefined} role={tenantPresentation ? 'region' : undefined} aria-labelledby={tenantPresentation ? 'safety-concern-title' : undefined} aria-busy={tenantPresentation && submitting ? true : undefined} className="gap-5 border border-rose-100 p-5 shadow-sm sm:p-8 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:shadow-none" data-testid="safety-concern-page">
        <div className="flex items-start gap-3 in-[.lichen-d5]:flex-wrap">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-rose-100 text-rose-700 in-[.lichen-d5]:rounded-md in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 id={tenantPresentation ? 'safety-concern-title' : undefined} className="text-xl font-bold tracking-tight text-slate-900 in-[.lichen-d5]:text-ink">Report a safety concern</h1>
            <p className="mt-1 text-sm text-slate-600 in-[.lichen-d5]:text-meta">
              For something that could hurt someone or damage the building. It goes to your property manager for urgent
              review and doesn&rsquo;t count toward your request limits.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-alert-line in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text in-[.lichen-d5]:[overflow-wrap:anywhere]" data-testid="safety-call-first">
          In danger right now? Call 911 first.
          {manager?.phone ? (
            <>
              {' '}
              Can&rsquo;t wait? Call {manager.name || 'your property manager'} at{' '}
              <a href={`tel:${manager.phone.replace(/[^\d+]/g, '')}`} className="font-semibold underline underline-offset-2">
                {manager.phone}
              </a>
              .
            </>
          ) : null}
        </div>

        <form className="space-y-4" onSubmit={submit} onSubmitCapture={tenantPresentation ? () => { submitFocus.current = true; } : undefined} noValidate>
          <div className="space-y-1.5">
            <label htmlFor="safety-title" className="text-sm font-medium text-slate-700 in-[.lichen-d5]:text-ink">
              What&rsquo;s the concern?
            </label>
            <input
              id="safety-title"
              data-testid="safety-title"
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Smell of gas in the kitchen"
              aria-invalid={Boolean(titleError)}
              aria-describedby={titleError ? 'safety-title-error' : undefined}
              className={`${fieldClass} ${TENANT_FIELD} ${titleError ? invalidFieldClass : ''}`}
            />
            <FieldError id="safety-title-error">{titleError}</FieldError>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="safety-description" className="text-sm font-medium text-slate-700 in-[.lichen-d5]:text-ink">
              What&rsquo;s happening, and where?
            </label>
            <textarea
              id="safety-description"
              data-testid="safety-description"
              value={description}
              maxLength={DESCRIPTION_MAX}
              rows={5}
              onChange={(e) => setDescription(e.target.value)}
              aria-invalid={Boolean(descriptionError)}
              aria-describedby={descriptionError ? 'safety-description-error' : undefined}
              className={`${fieldClass} ${TENANT_FIELD} h-auto min-h-[8rem] py-2 ${descriptionError ? invalidFieldClass : ''}`}
            />
            <FieldError id="safety-description-error">{descriptionError}</FieldError>
          </div>

          {submitError ? (
            <div
              role="alert"
              data-testid="safety-submit-error"
              className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-alert-line in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{submitError} Your details are still here — try again.</span>
            </div>
          ) : null}

          <p className="text-xs text-slate-500 in-[.lichen-d5]:text-meta">
            No vendor is contacted automatically. Your property manager decides what happens next.
          </p>

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" className="border-slate-200 in-[.lichen-d5]:border-border" onClick={() => navigate('/portal')}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="safety-submit"
              disabled={submitting}
              className="gap-2 bg-rose-600 text-white hover:bg-rose-700 in-[.lichen-d5]:bg-destructive in-[.lichen-d5]:text-destructive-foreground in-[.lichen-d5]:hover:bg-destructive/90"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
              {submitError ? 'Try again' : 'Send safety concern'}
            </Button>
          </div>
        </form>
      </Card>
    </TenantPage>
  );
}
