import { Mail } from 'lucide-react';
import { outreachLine } from '../../lib/requestWorkflow';
import type { OutreachSummary } from '../../types/requestWorkflow';

const TONE: Record<string, string> = {
  neutral: 'text-slate-500 in-[.lichen-d3]:text-meta',
  info: 'text-slate-600 in-[.lichen-d3]:text-meta',
  success: 'text-emerald-700 in-[.lichen-d3]:text-mist-text',
  warning: 'text-amber-700 in-[.lichen-d3]:text-lichen-text',
  danger: 'text-rose-700 in-[.lichen-d3]:text-alert-text',
};

/**
 * One quiet line for vendor outreach: who started it and only what the
 * persisted result establishes. Deliberately not a badge or a toast — the
 * landlord should notice it, not be alerted by it.
 */
export default function OutreachSummaryLine({
  summary,
  className = '',
  testId = 'outreach-summary',
}: {
  summary: OutreachSummary | null | undefined;
  className?: string;
  testId?: string;
}) {
  const line = outreachLine(summary);
  if (!line) return null;
  return (
    <div
      data-testid={testId}
      data-state={line.testState}
      data-initiation={summary?.initiation}
      className={`flex min-w-0 items-center gap-1.5 text-xs ${TONE[line.tone]} ${className}`}
    >
      <Mail className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate" title={line.label}>
        {line.label}
      </span>
    </div>
  );
}
