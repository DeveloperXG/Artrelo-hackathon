import { useEffect, useRef, useState } from 'react';
import { DollarSign, Info, Send, Settings2, ShieldCheck, Sparkles, TrendingDown } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { LandlordAPI } from '../../api/client';
import PageHeader from '../../components/landlord/PageHeader';
import StatCard, { StatGrid } from '../../components/landlord/StatCard';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { FieldError, invalidFieldClass } from '../../components/ui/FieldError';
import {
  FieldLabel,
  LandlordError,
  LandlordLoading,
  PageContainer,
  SectionCard,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import { useLandlordPolicy } from '../../hooks/landlord/useLandlordPolicy';
import { useRoutingSetup } from '../../hooks/landlord/useRoutingSetup';
import { useLandlordPaymentMode } from '../../hooks/landlord/useLandlordBadges';
import { useLiveTopic } from '../../hooks/useLiveTopic';
import type { Policy } from '../../types/landlord';
import { buildPolicyPut, classifySaveError, isNewerRevision, onPolicyNudge } from './policyCas';
import { isLichenLandlordPath } from '../../lib/lichenRoutes';

type ToggleKey =
  | 'requireApprovalOverQuota'
  | 'requireApprovalForFirstTimeVendor'
  | 'allowQuoteClarification'
  | 'allowAutopilotForLowSeverity'
  | 'allowAutopilotForMediumSeverity'
  | 'autoAdvanceOnVendorDecline';

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  comingSoon = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Shown but inert: the feature behind it isn't built yet. */
  comingSoon?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={comingSoon}
      aria-disabled={comingSoon || undefined}
      onClick={() => onChange(!checked)}
      // lichen: an 8px card row on white; hover is a neutral border/well step,
      // never a brand colour.
      className={`flex w-full flex-wrap items-center justify-between gap-4 rounded-xl border px-4 py-3.5 text-left [overflow-wrap:anywhere] transition motion-reduce:transition-none lichen:rounded-lg lichen:px-[min(1rem,16px)] ${
        comingSoon
          ? 'cursor-not-allowed border-dashed border-slate-300 bg-slate-50/60 lichen:border-chip-ring lichen:bg-well'
          : 'border-slate-200/80 bg-white hover:border-[#137fec]/30 hover:bg-slate-50/60 lichen:border-border lichen:bg-card lichen:hover:border-chip-ring lichen:hover:bg-well'
      }`}
    >
      {/* The 6rem basis keeps the switch beside the label at every normal
          width; only very large text drops it under the label (320 px at
          200% text), and a word wider than the row breaks instead of
          pushing the page sideways. */}
      <span className="min-w-0 flex-[1_1_6rem]">
        <span className={`flex flex-wrap items-center gap-1.5 text-sm font-semibold ${comingSoon ? 'text-slate-400 lichen:text-meta' : 'text-slate-800 lichen:text-ink'}`}>
          {label}
          {comingSoon ? (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 lichen:bg-pill-neutral lichen:text-meta">
              Coming soon
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs text-slate-500 lichen:text-meta">{description}</span>
      </span>
      {/* lichen: the track always has a visible control-border ring and the
          knob is a solid graphite/faint dot, so on and off read at 3:1 or
          better on white without relying on the pale Lichen fill. */}
      <span
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition motion-reduce:transition-none lichen:ring-1 lichen:ring-inset ${
          comingSoon
            ? 'bg-slate-200 opacity-60 lichen:bg-well lichen:ring-control-border'
            : checked
              ? 'bg-[#137fec] lichen:bg-lichen lichen:ring-lichen-icon'
              : 'bg-slate-200 lichen:bg-well lichen:ring-control-border'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition motion-reduce:transition-none lichen:shadow-none ${
            checked && !comingSoon ? 'translate-x-[22px] lichen:bg-on-lichen' : 'translate-x-0.5 lichen:bg-control-border'
          }`}
        />
      </span>
    </button>
  );
}

/** At 320 px with 200% text a description word can be wider than the card;
 * let it break rather than push the page sideways. No effect at normal sizes. */
const LARGE_TEXT_WRAP = '[&_p]:[overflow-wrap:anywhere]';

/** Under Lichen the four setting cards are a form, not a reveal: no staggered
 * entrance. The shared entrance rule is an unlayered style, hence the `!`. */
const LICHEN_STILL = 'lichen:animate-none!';
const SECTION_CLASS = `${LARGE_TEXT_WRAP} ${LICHEN_STILL}`;

/** Shared hint copy under a field label. */
const HINT = 'block text-xs text-slate-500 lichen:flex-1 lichen:text-meta';
/** Native number fields keep the inset fill under Lichen (bg-white hides it). */
const FIELD = 'h-10 bg-white lichen:shrink-0 lichen:bg-input-background lichen:font-mono lichen:tabular-nums';

const money = (value: number) => `$${Math.round(value).toLocaleString()}`;

function autopilotLabel(policy: Policy) {
  if (policy.allowAutopilotForLowSeverity && policy.allowAutopilotForMediumSeverity) return 'Low & Medium';
  if (policy.allowAutopilotForLowSeverity) return 'Low only';
  if (policy.allowAutopilotForMediumSeverity) return 'Medium only';
  return 'Off';
}

export default function PolicyPage() {
  useLandlordEntrance();
  const { policy, setPolicy, loading, error, reload } = useLandlordPolicy();
  const { setup, reload: reloadSetup } = useRoutingSetup();
  const hasWallet = useLandlordPaymentMode() === 'platform';
  const { hash, pathname } = useLocation();
  // Same gate the layout uses to put the page column under Lichen. Only the
  // section icon tiles need it: their colour is an inline style that a
  // lichen: class cannot reach, so under Lichen they are left out.
  const lichenPage = isLichenLandlordPath(pathname);
  const maxVendorsRef = useRef<HTMLInputElement>(null);
  const [quotaError, setQuotaError] = useState('');
  const [maxVendorsError, setMaxVendorsError] = useState('');
  const [lowFundsError, setLowFundsError] = useState('');
  const [saving, setSaving] = useState(false);

  // The tiles describe what is SAVED, not what is being typed: a quota
  // half-edited in the form isn't in force yet. Snapshot each time a load
  // finishes (the first load, and the reload after a save).
  const [saved, setSaved] = useState<Policy | null>(null);
  const wasLoading = useRef(true);
  useEffect(() => {
    if (wasLoading.current && !loading) setSaved(policy);
    wasLoading.current = loading;
  }, [loading, policy]);
  const dirty = Boolean(saved && policy && JSON.stringify(saved) !== JSON.stringify(policy));

  // Set when the saved policy moved on (Iris or another tab saved) while this
  // form was being edited. The edits stay on screen; only an explicit reload
  // replaces them.
  const [stale, setStale] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const loadedRevisionRef = useRef<number | null>(null);
  loadedRevisionRef.current = saved?.policyRevision ?? null;
  // Our own save also nudges; its follow-up reload covers that one.
  const savingRef = useRef(false);
  const reloadAll = () => {
    setStale(false);
    void reload();
    void reloadSetup();
  };
  useLiveTopic(['policy', 'iris_policy_changes'], () => {
    if (savingRef.current) return;
    if (onPolicyNudge(dirtyRef.current) === 'reload') {
      void reload();
      void reloadSetup();
      return;
    }
    // Topics are payload-free, so read the current revision without touching
    // the form, and warn only if it really moved past the one being edited.
    void LandlordAPI.getPolicy()
      .then((response) => {
        if (isNewerRevision((response.data as Policy | null)?.policyRevision, loadedRevisionRef.current)) setStale(true);
      })
      .catch(() => {});
  });

  // /dashboard/policy#vendor-outreach (the routing setup checklist) lands on
  // the vendor cap with the cursor in it. Once the form exists.
  const policyLoaded = Boolean(policy);
  useEffect(() => {
    if (hash !== '#vendor-outreach' || !policyLoaded) return;
    const input = maxVendorsRef.current;
    if (!input) return;
    input.scrollIntoView({ block: 'center' });
    input.focus({ preventScroll: true });
    input.select();
  }, [hash, policyLoaded]);

  const savePolicy = async () => {
    if (!policy) return;
    // The quota has no default any more, so saving without one would keep every
    // job on manual approval — say so beside the field instead.
    if (policy.defaultQuota === null || !(policy.defaultQuota > 0)) {
      setQuotaError('Enter a default quota greater than $0.');
      return;
    }
    setQuotaError('');
    setMaxVendorsError('');
    setLowFundsError('');
    setSaving(true);
    savingRef.current = true;
    try {
      // Edited from the revision that was loaded, not whatever is current now.
      const result = await LandlordAPI.updatePolicy(
        buildPolicyPut(policy, (saved ?? policy).policyRevision ?? null, { hasWallet })
      );
      // A routing change re-evaluates open requests in the background; the
      // bell reports what moved once it has.
      toast.success(
        (result as { reevaluating?: boolean }).reevaluating
          ? 'Policy updated. Re-evaluating your open requests now.'
          : 'Policy updated'
      );
      await Promise.all([reload(), reloadSetup()]);
    } catch (error) {
      const failure = classifySaveError(error);
      if (failure.kind === 'stale') setStale(true);
      else if (failure.kind === 'field' && failure.field === 'defaultQuota') setQuotaError(failure.message || 'Check the quota.');
      else if (failure.kind === 'field' && failure.field === 'maxOutreachAttempts')
        setMaxVendorsError(failure.message || 'Check this number.');
      else if (failure.kind === 'field') setLowFundsError(failure.message || 'Check this amount.');
      else toast.error(failure.message || 'Failed');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Only the first load blanks the page; the reload after a save keeps the
  // form on screen.
  if (loading && !policy) {
    return <LandlordLoading label="Loading policy..." />;
  }

  if (error || !policy) {
    return (
      <LandlordError
        title="Policy unavailable"
        message={error || 'No policy found'}
        onRetry={() => void reload()}
      />
    );
  }

  const toggle = (key: ToggleKey) => (value: boolean) => setPolicy({ ...policy, [key]: value });
  // Against the value being typed, not the saved one: the note answers "what
  // would this number mean", which is the question while editing it.
  const vendorCount = setup?.activeVendorCount ?? null;
  const maxVendors = policy.maxOutreachAttempts ?? 0;
  const capExceedsNetwork = vendorCount !== null && vendorCount > 0 && vendorCount < maxVendors;
  const noVendors = vendorCount === 0;
  const summary = saved || policy;

  return (
    // Keep normal card padding when root text doubles: a nested form card
    // should spend its narrow width on readable text rather than larger gaps.
    <PageContainer className="lichen:[&_.ll-fade-up]:animate-none! lichen:[&_.ll-fade-up]:p-[min(1.25rem,20px)]">
      <PageHeader
        title="Policy & Quotas"
        description="Set rules for approvals, routing, and spending safeguards."
        actions={
          <>
            {dirty ? (
              // lichen: a pending human action, so the Lichen pill role (no amber hue).
              <span
                className="text-xs font-medium text-amber-600 lichen:rounded-full lichen:border lichen:border-lichen-line lichen:bg-lichen-tint lichen:px-2.5 lichen:py-1 lichen:text-lichen-pill"
                data-testid="policy-unsaved"
              >
                Unsaved changes
              </span>
            ) : null}
            <Button
              onClick={() => void savePolicy()}
              // Nothing to save until the form differs from the saved policy;
              // editing a field back to its saved value disables it again.
              // A stale form cannot save: it would be refused anyway.
              disabled={saving || !dirty || stale}
              title={dirty ? undefined : 'No changes to save'}
              className="h-10 bg-[#137fec] px-5 hover:bg-[#137fec]/90 lichen:bg-primary lichen:font-semibold lichen:text-primary-foreground lichen:hover:bg-primary/90"
              data-testid="policy-save"
            >
              Save changes
            </Button>
          </>
        }
      />

      {stale ? (
        <div
          role="alert"
          // lichen: the decisions-banner role (wash + line, ink text): the
          // landlord has to act before this form can save.
          className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 lichen:rounded-lg lichen:border-lichen-line lichen:bg-lichen-wash lichen:text-ink"
          data-testid="policy-stale"
        >
          <p className="font-semibold">Your policy was changed somewhere else</p>
          <p className="mt-0.5">
            It was saved again (for example by Iris or in another tab) after you opened this page.
            {dirty ? ' Your edits below were not saved and are still here.' : ''} Reload to see the current policy
            {dirty ? ', then make your edits again' : ''}.
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={reloadAll} data-testid="policy-reload">
            Reload current policy
          </Button>
        </div>
      ) : null}

      <StatGrid className={`mb-6 ${hasWallet ? '' : 'lg:@min-[58rem]/page:grid-cols-3'}`}>
        <StatCard
          icon={DollarSign}
          tone="blue"
          label="Default quota"
          value={summary.defaultQuota != null ? money(summary.defaultQuota) : 'Not set'}
          sub={summary.defaultQuota != null ? 'Per job, no approval needed' : 'Every job needs your approval'}
          testId="policy-summary-quota"
          wrap
        />
        {hasWallet ? <StatCard
          icon={TrendingDown}
          tone="blue"
          label="Low-funds threshold"
          value={money(summary.lowFundsThreshold || 0)}
          sub="Emails you when the balance dips below"
          wrap
          delay={lichenPage ? 0 : 60}
        /> : null}
        <StatCard
          icon={Send}
          tone="blue"
          label="Vendor auto-contact"
          value={summary.autoAdvanceOnVendorDecline ? 'On' : 'Off'}
          sub={summary.autoAdvanceOnVendorDecline ? 'Next vendor contacted automatically' : 'You choose the next vendor'}
          wrap
          delay={lichenPage ? 0 : 120}
        />
        <StatCard
          icon={Settings2}
          tone="blue"
          label="Autopilot coverage"
          value={autopilotLabel(summary)}
          sub="Auto-route qualifying requests"
          wrap
          // Lichen keeps this form still; legacy pages retain their cascade.
          delay={lichenPage ? 0 : 180}
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-6">
        <SectionCard
          className={SECTION_CLASS}
          icon={lichenPage ? undefined : DollarSign}
          title={hasWallet ? 'Quotas & funds' : 'Spending limits'}
          description="Set spending limits that trigger approvals and alerts."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="space-y-1.5 lichen:flex lichen:flex-col">
              <FieldLabel className="lichen:text-meta">Default quota ($)</FieldLabel>
              <span id="policy-quota-hint" className={HINT}>
                Jobs up to this amount can go ahead without asking you.
              </span>
              <Input
                type="number"
                min="1"
                className={`${FIELD} ${quotaError ? invalidFieldClass : ''}`}
                // Empty, not 0, when unset: there is no limit until one is chosen.
                value={policy.defaultQuota ?? ''}
                placeholder="Not set"
                aria-invalid={Boolean(quotaError)}
                aria-describedby={quotaError ? 'policy-quota-error' : 'policy-quota-hint'}
                onChange={(event) => {
                  setQuotaError('');
                  const raw = event.target.value;
                  setPolicy({ ...policy, defaultQuota: raw === '' ? null : Number(raw) });
                }}
                data-testid="policy-default-quota"
              />
              {quotaError ? <FieldError id="policy-quota-error">{quotaError}</FieldError> : null}
            </label>
            {hasWallet ? <label className="space-y-1.5 lichen:flex lichen:flex-col">
              <FieldLabel className="lichen:text-meta">Low-funds threshold ($)</FieldLabel>
              {/* Says when and where: lowBalance.service checks when a vendor is
                  booked (the amount is held) and when a job is paid, notifies
                  and emails at most once a day, and the Wallet shows it too. */}
              <span id="policy-low-funds-hint" className={HINT}>
                When booking a vendor or paying a job leaves your available wallet balance below this,
                we&rsquo;ll email you and notify you here (at most once a day). Your Wallet shows it too.
              </span>
              <Input
                type="number"
                min="0"
                className={`${FIELD} ${lowFundsError ? invalidFieldClass : ''}`}
                value={policy.lowFundsThreshold}
                aria-invalid={Boolean(lowFundsError)}
                aria-describedby={lowFundsError ? 'policy-low-funds-hint policy-low-funds-error' : 'policy-low-funds-hint'}
                onChange={(event) => {
                  setLowFundsError('');
                  setPolicy({ ...policy, lowFundsThreshold: Number(event.target.value) });
                }}
                data-testid="policy-low-funds"
              />
              {lowFundsError ? <FieldError id="policy-low-funds-error">{lowFundsError}</FieldError> : null}
            </label> : null}
          </div>
        </SectionCard>

        <SectionCard
          className={SECTION_CLASS}
          icon={lichenPage ? undefined : ShieldCheck}
          title="Approvals"
          description="Decide which actions require your sign-off."
          delay={70}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {/* Nothing searches beyond the landlord's network yet -- recommendations
                come only from vendors they added -- so a working switch here
                would be a setting with no effect. Shown so it's discoverable. */}
            <ToggleRow
              label="External vendor search"
              description="Approve before Artrelo searches beyond your vendor network."
              checked={false}
              onChange={() => undefined}
              comingSoon
            />
            <ToggleRow
              label="Over-quota jobs"
              description="Approve work that exceeds the default quota."
              checked={Boolean(policy.requireApprovalOverQuota)}
              onChange={toggle('requireApprovalOverQuota')}
            />
            <ToggleRow
              label="First-time vendors"
              description="Approve before using a vendor for the first time."
              checked={Boolean(policy.requireApprovalForFirstTimeVendor)}
              onChange={toggle('requireApprovalForFirstTimeVendor')}
            />
          </div>
          {/* Off by default. A follow-up is a question, never a price: it
              authorizes no spend and every cost still comes back for review. */}
          <div className="mt-3" data-testid="policy-quote-clarification">
            <ToggleRow
              label="Routine quote follow-up"
              description="Let Iris ask the vendor one routine, line-specific question about an itemized quote or final charges without asking you first. At most one round per quote or invoice and two per request. It never approves a price or spend."
              checked={Boolean(policy.allowQuoteClarification)}
              onChange={toggle('allowQuoteClarification')}
            />
          </div>
        </SectionCard>

        <SectionCard
          className={SECTION_CLASS}
          icon={lichenPage ? undefined : Sparkles}
          iconColor="#a855f7"
          title="Autopilot"
          description="Let Artrelo route lower-risk work automatically."
          delay={140}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <ToggleRow
              label="Low severity"
              description="Start eligible low-severity requests automatically, within your quota and review rules."
              checked={Boolean(policy.allowAutopilotForLowSeverity)}
              onChange={toggle('allowAutopilotForLowSeverity')}
            />
            <ToggleRow
              label="Medium severity"
              description="Start eligible medium-severity requests automatically, within your quota and review rules."
              checked={Boolean(policy.allowAutopilotForMediumSeverity)}
              onChange={toggle('allowAutopilotForMediumSeverity')}
            />
            {/* lichen: a standing guarantee, so a neutral well with ink text rather than a brand tint. */}
            <div className="flex items-center gap-3 rounded-xl border border-[#137fec]/15 bg-[#137fec]/[0.05] px-4 py-3.5 lichen:rounded-lg lichen:border-border lichen:bg-well lichen:px-[min(1rem,16px)] lichen:text-ink text-sm text-slate-600 [overflow-wrap:anywhere]">
              <Info className="h-5 w-5 shrink-0 text-[#137fec] lichen:text-chip-icon" aria-hidden />
              Emergency requests are never auto-routed — they always come to you.
            </div>
          </div>
        </SectionCard>

        <SectionCard
          className={SECTION_CLASS}
          icon={lichenPage ? undefined : Send}
          iconColor="#0ea5e9"
          title="Vendor outreach"
          description="What happens when a vendor declines or doesn't reply in time."
          delay={210}
        >
          <div id="vendor-outreach" className="grid scroll-mt-24 grid-cols-1 gap-3 md:grid-cols-2">
            <ToggleRow
              label="Auto-contact next vendor"
              description="Skip re-approval and email the next-best match automatically."
              checked={Boolean(policy.autoAdvanceOnVendorDecline)}
              onChange={toggle('autoAdvanceOnVendorDecline')}
            />
            <label className="min-w-0 space-y-1.5 rounded-xl border border-slate-200/80 bg-white px-4 py-3 lichen:rounded-lg lichen:border-border lichen:bg-card lichen:px-[min(1rem,16px)] [overflow-wrap:anywhere]">
              <span className="block text-sm font-semibold text-slate-800 lichen:text-ink">Max vendors contacted per request</span>
              <span id="policy-max-vendors-hint" className={HINT}>
                {maxVendors === 0
                  ? 'At 0, Artrelo won’t contact any vendor. Choose 1 to 5 to turn vendor routing on.'
                  : 'After this many vendors the request pauses for you to assign it.'}
              </span>
              <Input
                ref={maxVendorsRef}
                type="number"
                min={0}
                max={5}
                step={1}
                className={`${FIELD} ${maxVendorsError ? invalidFieldClass : ''}`}
                value={maxVendors}
                aria-invalid={Boolean(maxVendorsError)}
                aria-describedby={[
                  'policy-max-vendors-hint',
                  maxVendorsError ? 'policy-max-vendors-error' : '',
                  capExceedsNetwork || noVendors ? 'policy-max-vendors-note' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onChange={(event) => {
                  setMaxVendorsError('');
                  setPolicy({ ...policy, maxOutreachAttempts: Number(event.target.value) });
                }}
                data-testid="policy-max-vendors"
              />
              {maxVendorsError ? (
                <FieldError id="policy-max-vendors-error">{maxVendorsError}</FieldError>
              ) : null}
              {noVendors ? (
                <span
                  id="policy-max-vendors-note"
                  className="flex items-start gap-1.5 text-xs text-amber-700 lichen:text-lichen-text"
                  data-testid="policy-max-vendors-note"
                >
                  <Info className="mt-px h-3.5 w-3.5 shrink-0" />
                  You have no active vendors yet, so nobody can be contacted. Add one on the Vendors page.
                </span>
              ) : capExceedsNetwork ? (
                <span
                  id="policy-max-vendors-note"
                  className="flex items-start gap-1.5 text-xs text-amber-700 lichen:text-lichen-text"
                  data-testid="policy-max-vendors-note"
                >
                  <Info className="mt-px h-3.5 w-3.5 shrink-0" />
                  You have {vendorCount} active vendor{vendorCount === 1 ? '' : 's'}, so at most {vendorCount}{' '}
                  will be contacted per request. Add vendors to use the full {maxVendors}.
                </span>
              ) : null}
            </label>
          </div>
        </SectionCard>
      </div>
    </PageContainer>
  );
}
