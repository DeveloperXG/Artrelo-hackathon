import { useEffect, useState } from 'react';
import type { Evidence, ImpactRow, PolicyChangeView } from '../../types/irisV2';
import type { IrisFailure } from './irisApi';
import type { PendingConfirm } from './irisController';
import {
  ERROR_COPY,
  FIELD_LABELS,
  POLICY_STATE_COPY,
  REFRESH_COPY,
  STAGE_LABELS,
  confirmFailureCopy,
  failureCopy,
} from './irisCopy';
import { formatMinorCAD, formatTime, onOff } from './irisFormat';
import { TableRegion } from './IrisBlocks';
import { IrisEvidencePeek, IrisLink } from './IrisEvidencePeek';
import { useIris } from './IrisProvider';
import { ROUTE_PATHS } from './irisRoutes';

const DISPOSITION: Record<ImpactRow['disposition'], string> = {
  eligible_next: 'Uses the new setting at its next check',
  retained_passed: 'Already passed; keeps its recorded outcome',
  shadowed: 'A more specific limit applies instead',
  not_applicable: 'Not affected',
  legacy_unknown: 'Unknown: older records are incomplete',
};

const COUNT_LABELS: [keyof PolicyChangeView['impactCounts'], string][] = [
  ['eligible', 'use the new setting at their next check'],
  ['passed', 'already passed'],
  ['shadowed', 'have a more specific limit'],
  ['notApplicable', 'not affected'],
  ['unknown', 'unknown'],
];

function ImpactList({ previewId }: { previewId: string }) {
  const iris = useIris();
  const [rows, setRows] = useState<ImpactRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [failure, setFailure] = useState<IrisFailure | null>(null);

  const load = async (from: string | null) => {
    if (!iris) return;
    setState('loading');
    const result = await iris.controller.impactPage(previewId, from);
    if (!result) return;
    if (!result.ok) {
      setFailure(result.failure);
      setState('error');
      return;
    }
    setRows((prev) => (from ? [...prev, ...result.value.rows] : result.value.rows));
    setCursor(result.value.complete ? null : result.value.nextCursor);
    setState(result.value.complete || !result.value.nextCursor ? 'done' : 'idle');
  };

  useEffect(() => {
    void load(null);
    // Each preview has its own manifest; reload only when the preview changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewId]);

  return (
    <div className="mt-2">
      {rows.length ? (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {rows.map((row) => (
            <li key={`${row.requestRef}:${row.field}:${row.checkpoint}`} className="p-2 text-sm">
              <IrisLink href={`/dashboard/requests/${row.requestId}?tab=activity`}>{row.requestTitle || 'Request'}</IrisLink>
              <p className="text-xs text-meta">
                {FIELD_LABELS[row.field]} · {DISPOSITION[row.disposition]}
              </p>
              {row.reasonLabel ? <p className="text-xs [overflow-wrap:anywhere]">{row.reasonLabel}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {state === 'loading' ? (
        <p className="mt-1 text-xs text-meta" role="status">
          Loading affected requests…
        </p>
      ) : null}
      {state === 'error' ? <p className="mt-1 text-xs text-alert-text">{failureCopy(failure)}</p> : null}
      {state === 'idle' && cursor ? (
        <button type="button" onClick={() => void load(cursor)} className="mt-1 rounded-md text-sm font-medium text-lichen-text underline">
          Show more affected requests
        </button>
      ) : null}
    </div>
  );
}

function Receipt({ view }: { view: PolicyChangeView }) {
  const values = view.verifiedValues;
  const [auditOpen, setAuditOpen] = useState(false);
  const audit: Evidence | null = view.auditRef
    ? {
        ref: view.auditRef,
        kind: 'audit',
        recordId: view.auditRef,
        requestId: null,
        // No page link is invented for an audit record; the peek is the source.
        routeKind: 'none',
        publicRouteKind: null,
        lastVerifiedAt: null,
        revision: view.appliedRevision,
        hash: null,
        occurredAt: null,
        label: 'Audit record for this change',
      }
    : null;
  return (
    <div className="mt-2 rounded-lg border border-lichen-line bg-lichen-wash p-3" data-testid="iris-receipt">
      <p className="font-medium">Saved as policy revision {view.appliedRevision ?? 'unknown'}</p>
      {values ? (
        // The same Setting column as the preview table above it, read back from the saved policy.
        <TableRegion label="Saved policy values" testId="iris-receipt-table">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Saved policy values, read back after saving</caption>
            <thead>
              <tr className="text-xs text-meta">
                <th scope="col" className="px-3 py-1 font-normal">Setting</th>
                <th scope="col" className="px-3 py-1 font-normal">Saved value (verified)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-hairline">
                <th scope="row" className="px-3 py-1 font-normal text-meta">Default quota</th>
                <td className="px-3 py-1 font-mono tabular-nums">{formatMinorCAD(values.defaultQuotaMinor)}</td>
              </tr>
              <tr className="border-t border-hairline">
                <th scope="row" className="px-3 py-1 font-normal text-meta">Low-severity autopilot</th>
                <td className="px-3 py-1">{onOff(values.lowAutopilot)}</td>
              </tr>
              <tr className="border-t border-hairline">
                <th scope="row" className="px-3 py-1 font-normal text-meta">Medium-severity autopilot</th>
                <td className="px-3 py-1">{onOff(values.mediumAutopilot)}</td>
              </tr>
            </tbody>
          </table>
        </TableRegion>
      ) : (
        <p className="text-sm text-meta">The saved values could not be read back yet.</p>
      )}
      <p className="mt-2 text-sm" role="status">
        {REFRESH_COPY[view.refreshState]}
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        <IrisLink href={ROUTE_PATHS.policy!}>View Policy</IrisLink>
        {audit ? (
          <button type="button" aria-expanded={auditOpen} onClick={() => setAuditOpen(!auditOpen)} className="rounded-md text-sm font-medium text-lichen-text underline">
            Audit record
          </button>
        ) : null}
      </div>
      {audit && auditOpen ? <IrisEvidencePeek evidence={audit} historicalLabel={null} /> : null}
    </div>
  );
}

/**
 * The server's policy change, shown exactly: old -> new values, the revision
 * it was built on, expiry, complete impact, real stages, and the outcome. The
 * Confirm button exists only while the token is held for the current context.
 */
export function IrisPolicyCard({ preview, inertReason }: { preview: PolicyChangeView; inertReason: string | null }) {
  const iris = useIris();
  if (!iris) return null;
  const { controller, state } = iris;
  const view = state.policyChanges[preview.id] ?? preview;
  const pending: PendingConfirm | undefined = state.pendingConfirms.find((p) => p.previewId === preview.id);
  const live = state.livePreviewIds.includes(preview.id) && controller.canConfirm(preview.id);
  const expired = view.state === 'preview_ready' && Date.parse(view.expiresAt) <= Date.now();
  const confirmable = live && view.state === 'preview_ready' && !expired && view.impactComplete;
  const shownState = pending?.view?.state ?? view.state;
  const applied = (pending?.view ?? view).state === 'applied';

  return (
    <section
      aria-label="Policy change"
      className="rounded-lg border border-hairline bg-surface p-3 shadow-lichen-card"
      data-testid="iris-policy-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{applied ? 'Policy change receipt' : 'Policy change preview'}</p>
        <span className="rounded-full bg-chip px-2 py-0.5 text-xs text-ink">Your whole account</span>
      </div>
      <p className="mt-1 text-sm" role="status">
        {expired && shownState === 'preview_ready' ? POLICY_STATE_COPY.expired : POLICY_STATE_COPY[shownState]}
      </p>
      {/* At large text the three columns can outgrow a phone sheet; the table
          scrolls inside a named, focusable region instead of clipping values. */}
      <div role="region" aria-label="Policy settings changed" tabIndex={0} className="mt-2 overflow-x-auto rounded-sm outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring forced-colors:focus-visible:outline-[Highlight]" data-testid="iris-policy-table">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-meta">
              <th scope="col" className="py-1 font-normal">
                Setting
              </th>
              <th scope="col" className="py-1 font-normal">
                {applied ? 'Before' : 'Now'}
              </th>
              <th scope="col" className="py-1 font-normal">
                {applied ? 'After' : 'Proposed'}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.changes.map((change) => (
              <tr key={change.field} className="border-t border-hairline">
                <th scope="row" className="py-1 pr-2 font-normal">
                  {FIELD_LABELS[change.field]}
                </th>
                <td className="py-1 pr-2 font-mono tabular-nums">{change.before}</td>
                <td className="py-1 font-mono tabular-nums">{change.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-meta">
        Built on saved policy revision {view.basePolicyRevision ?? 'none'} · as of {formatTime(view.asOf)}
        {view.state === 'preview_ready' ? ` · expires ${formatTime(view.expiresAt)}` : ''}
      </p>

      <div className="mt-3">
        <p className="text-sm font-medium">Requests this affects</p>
        <ul className="mt-1 text-sm">
          {COUNT_LABELS.map(([key, label]) => (
            <li key={key}>
              {view.impactCounts[key]} {label}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-meta">
          New requests and checks that have not run yet will use the new settings. Nothing is approved by this change.
        </p>
        {!view.impactComplete ? <p className="mt-1 text-sm text-alert-text">{ERROR_COPY.impact_incomplete}</p> : null}
        <ImpactList previewId={view.id} />
      </div>

      <ol className="mt-3 flex flex-wrap gap-1.5" aria-label="Stages">
        {view.stages.map((stage) => (
          <li
            key={stage.stage}
            className={`rounded-full px-2 py-0.5 text-xs ${
              stage.state === 'completed'
                ? 'bg-lichen-tint text-lichen-pill'
                : stage.state === 'failed'
                  ? 'bg-alert-tint text-alert-text'
                  : 'bg-chip text-meta'
            }`}
          >
            {STAGE_LABELS[stage.stage]}: {stage.state === 'completed' ? 'done' : stage.state === 'failed' ? 'failed' : 'not yet'}
          </li>
        ))}
      </ol>

      {pending?.phase === 'confirming' ? (
        <p className="mt-3 text-sm" role="status">
          Confirming… Artrelo is validating, saving, verifying and recording this change.
        </p>
      ) : null}
      {pending?.phase === 'unknown' ? (
        <div className="mt-3 text-sm" role="status">
          <p>Iris did not get an answer, so it is checking whether the change was applied. It will not send the change again.</p>
          {pending.statusStalled ? (
            <button type="button" onClick={() => controller.checkStatus(preview.id)} className="mt-1 rounded-md font-medium text-lichen-text underline">
              Check status again
            </button>
          ) : null}
        </div>
      ) : null}
      {pending?.phase === 'not_applied' ? (
        <p className="mt-3 text-sm" role="status">
          Checked: this change was not applied. The preview is still valid, so you can confirm it again.
        </p>
      ) : null}
      {pending?.phase === 'settled' && pending.failure ? (
        <p className="mt-3 text-sm text-alert-text" role="status">
          {confirmFailureCopy(pending.failure)}
        </p>
      ) : null}
      {applied ? <Receipt view={pending?.view ?? view} /> : null}

      {confirmable ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void controller.confirm(preview.id)}
            className="rounded-md bg-lichen px-3 py-1.5 text-sm font-medium text-on-lichen hover:opacity-90"
            data-testid="iris-confirm"
          >
            {pending?.phase === 'not_applied' ? 'Confirm again' : 'Confirm change'}
          </button>
          <button
            type="button"
            onClick={() => void controller.discard(preview.id)}
            className="rounded-md border border-control-border bg-surface px-3 py-1.5 text-sm text-ink hover:bg-accent"
          >
            Discard
          </button>
        </div>
      ) : !pending && view.state === 'preview_ready' && !expired ? (
        <p className="mt-3 text-sm text-meta">{inertReason ?? 'This preview is no longer active. No change was applied.'}</p>
      ) : null}
    </section>
  );
}
