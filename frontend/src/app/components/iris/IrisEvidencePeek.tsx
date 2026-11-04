import { useEffect, useState } from 'react';
import type { Evidence, EvidenceView } from '../../types/irisV2';
import type { IrisFailure } from './irisApi';
import { ERROR_COPY, failureCopy } from './irisCopy';
import { formatTime } from './irisFormat';
import { useIris } from './IrisProvider';
import { evidenceHref, linkLabel } from './irisRoutes';

const KIND_LABEL: Record<Evidence['kind'], string> = {
  request: 'Request',
  quote_revision: 'Quote',
  final_statement: 'Final statement',
  decision: 'Decision',
  checkpoint: 'Checkpoint',
  scheduling_event: 'Scheduling',
  policy_revision: 'Saved policy',
  policy_change: 'Policy change',
  audit: 'Audit record',
  help_article: 'Product guide',
};

export function evidenceMeta(e: Evidence) {
  if (e.kind === 'help_article') {
    const parts = ['Product guide'];
    if (e.revision !== null) parts.push(`version ${e.revision}`);
    if (e.lastVerifiedAt) parts.push(`verified ${formatTime(e.lastVerifiedAt)}`);
    return parts.join(' · ');
  }
  if (e.kind === 'policy_revision' && e.revision !== null) return `Saved policy revision ${e.revision}`;
  const parts = [KIND_LABEL[e.kind]];
  if (e.revision !== null) parts.push(`revision ${e.revision}`);
  if (e.occurredAt) parts.push(formatTime(e.occurredAt));
  return parts.join(' · ');
}

function peekFailure(failure: IrisFailure) {
  if (failure.kind === 'http') {
    if (failure.code === 'record_not_found') return 'This source is no longer available.';
    return ERROR_COPY[failure.code];
  }
  return failureCopy(failure);
}

/**
 * One source, read fresh from the server each time it opens: the server
 * re-checks ownership, so an answer from an earlier page still shows only what
 * this account may see now, and never a newer record in place of the old one.
 */
export function IrisEvidencePeek({
  evidence,
  historicalLabel,
}: {
  evidence: Evidence;
  /** Set when the source belongs to an earlier part of the conversation. */
  historicalLabel: string | null;
}) {
  const iris = useIris();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ok'; view: EvidenceView } | { status: 'error'; failure: IrisFailure }>({
    status: 'loading',
  });
  const controller = iris?.controller;

  useEffect(() => {
    if (!controller) return undefined;
    const abort = new AbortController();
    void controller.evidence(evidence.ref, abort.signal).then((result) => {
      if (!result || abort.signal.aborted) return;
      setState(result.ok ? { status: 'ok', view: result.value } : { status: 'error', failure: result.failure });
    });
    return () => abort.abort();
  }, [controller, evidence.ref]);

  const href = evidenceHref(evidence);
  return (
    <div className="mt-2 rounded-lg border border-hairline bg-well p-3 text-sm text-ink" data-testid="iris-evidence-peek">
      {historicalLabel ? (
        <p className="mb-1 text-xs text-meta">From an earlier part of this conversation: {historicalLabel}</p>
      ) : null}
      <p className="font-medium">{evidence.label}</p>
      <p className="text-xs text-meta">{evidenceMeta(evidence)}</p>
      {state.status === 'loading' ? (
        <p className="mt-2 text-meta" role="status">
          Loading source…
        </p>
      ) : state.status === 'error' ? (
        <p className="mt-2 text-alert-text" role="status">
          {peekFailure(state.failure)}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {state.view.facts.length === 0 ? <li className="text-meta">No details are recorded for this source.</li> : null}
          {state.view.facts.map((fact) => (
            <li key={fact.factId} className="[overflow-wrap:anywhere]">
              {fact.text}
            </li>
          ))}
        </ul>
      )}
      {href ? (
        <IrisLink href={href} className="mt-2 inline-block">
          {linkLabel(href)}
        </IrisLink>
      ) : null}
    </div>
  );
}

/** An in-panel link to a literal app route (see irisRoutes). */
export function IrisLink({ href, children, className = '' }: { href: string; children: React.ReactNode; className?: string }) {
  const iris = useIris();
  return (
    <a
      href={href}
      className={`rounded-md text-sm font-medium text-lichen-text underline underline-offset-2 ${className}`}
      onClick={(event) => {
        if (!iris || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        iris.follow(href);
      }}
    >
      {children}
    </a>
  );
}
