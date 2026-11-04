import { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import { TenantAPI } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { fieldClass } from '../landlord/landlordUi';
import { TENANT_FIELD, useTenantPresentation } from './tenantPresentation';
import { clearCarriedDraft, readCarriedDraft, workflowConflict, type CarriedDraft } from '../../lib/requestWorkflow';
import type { RequestDetailRecord } from '../request-detail/requestDetailTypes';
import { useSubmissionKey } from '../../hooks/useSubmissionKey';

/**
 * What the tenant typed in a new intake before saying "same issue", waiting
 * for one more confirmation before it is saved onto this request as an
 * update. Never saved on navigation, and spends no request quota.
 */
export default function CarriedUpdateCard({
  request,
  onRequestReplaced,
}: {
  request: RequestDetailRecord;
  onRequestReplaced: (next: RequestDetailRecord) => void;
}) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const fromState = (location.state as { carryover?: CarriedDraft } | null)?.carryover;
  const [draft] = useState<CarriedDraft | null>(() => fromState || readCarriedDraft(user?.id, request._id));
  const [body, setBody] = useState(draft?.body || '');
  const [open, setOpen] = useState(Boolean(draft));
  // The id minted when the draft was carried over covers the text as carried;
  // editing it after a failed save makes a new submission.
  const submissionKey = useSubmissionKey(
    draft ? { id: draft.submissionId, payload: { body: draft.body.trim(), intakeMode: 'routine' } } : undefined
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const tenantPresentation = useTenantPresentation();
  const headingId = useId();
  const previousOpen = useRef(open);
  const arrivalFocus = useRef(Boolean(fromState));
  const saveButton = useRef<HTMLButtonElement>(null);
  const saveFocus = useRef(false);

  useEffect(() => {
    if (!tenantPresentation) return;
    const wasOpen = previousOpen.current;
    previousOpen.current = open;
    if ((!open && !wasOpen) || (open && !arrivalFocus.current)) return;
    const frame = requestAnimationFrame(() => {
      arrivalFocus.current = false;
      if (document.querySelector('[role=dialog],[role=alertdialog]') ||
          ![document.body, document.documentElement].includes(document.activeElement as HTMLElement)) return;
      const destination = open ? cardRef.current?.querySelector<HTMLElement>('textarea') :
        document.querySelector<HTMLElement>('[data-testid=detail-comment-input]');
      destination?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [tenantPresentation, open]);

  useEffect(() => {
    if (!tenantPresentation || !saveFocus.current) return;
    const frame = requestAnimationFrame(() => {
      const current = document.activeElement;
      if (!document.querySelector('[role=dialog],[role=alertdialog]') &&
          (current === cardRef.current || [document.body, document.documentElement].includes(current as HTMLElement))) {
        const destination = !open ? document.querySelector<HTMLElement>('[data-testid=detail-comment-input]') :
          saving ? cardRef.current : error ? saveButton.current : null;
        destination?.focus();
      }
      if (!saving) saveFocus.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [tenantPresentation, saving, error, open]);

  useEffect(() => {
    if (open) cardRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  if (!open || !draft) return null;

  const finish = () => {
    clearCarriedDraft(user?.id, request._id);
    // Drop it from history state so Back/refresh never offers it again.
    navigate(location.pathname + location.search, { replace: true, state: null });
    setOpen(false);
  };

  const save = async () => {
    if (!body.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      // No revision: the server versions updates by the follow-up, not the
      // request, and an update appends rather than overwriting anything.
      const payload = { body: body.trim(), intakeMode: 'routine' as const };
      const res = await TenantAPI.postRequestUpdate(request._id, { ...payload, submissionId: submissionKey.idFor(payload) });
      if (res.data) onRequestReplaced(res.data as RequestDetailRecord);
      finish();
    } catch (e) {
      const conflict = workflowConflict<RequestDetailRecord>(e);
      if (conflict?.code === 'idempotency_conflict') submissionKey.reset();
      if (conflict?.latest) onRequestReplaced(conflict.latest);
      setError(
        conflict?.code === 'request_not_editable'
          ? 'This request is closed to updates. Start a new request instead.'
          : `${e instanceof Error ? e.message : 'Your update was not saved.'} It’s still here — try again.`
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card ref={cardRef} tabIndex={tenantPresentation ? -1 : undefined} role={tenantPresentation ? 'group' : undefined} aria-labelledby={tenantPresentation ? headingId : undefined} aria-busy={tenantPresentation && saving ? true : undefined} className="gap-3 border border-[#137fec]/30 p-5 shadow-sm in-[.lichen-d5]:border-lichen-line in-[.lichen-d5]:shadow-none" data-testid="carried-update">
      <div id={tenantPresentation ? headingId : undefined} className="flex items-center gap-2 text-sm font-semibold text-slate-900 in-[.lichen-d5]:text-ink">
        <MessageSquarePlus className="h-4 w-4 text-[#137fec] in-[.lichen-d5]:text-lichen-text" aria-hidden="true" />
        Add this as an update to this request?
      </div>
      <p className="text-sm text-slate-600 in-[.lichen-d5]:text-meta">Review what you wrote. Nothing is saved until you choose Add update.</p>
      <textarea
        aria-label="Update to add"
        data-testid="carried-update-body"
        data-tenant-route-focus={tenantPresentation && fromState && draft && open && !saving ? 'carried-update' : undefined}
        value={body}
        rows={4}
        maxLength={4000}
        onChange={(e) => setBody(e.target.value)}
        className={`${fieldClass} ${TENANT_FIELD} h-auto py-2`}
      />
      {error ? (
        <p role="alert" className="text-sm text-amber-800 in-[.lichen-d5]:text-lichen-text" data-testid="carried-update-error">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={finish} data-testid="carried-update-discard">
          Discard
        </Button>
        <Button
          ref={saveButton}
          onClickCapture={tenantPresentation ? () => { saveFocus.current = true; } : undefined}
          onClick={() => void save()}
          disabled={saving || !body.trim()}
          data-testid="carried-update-save"
          className="gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Add update
        </Button>
      </div>
    </Card>
  );
}
