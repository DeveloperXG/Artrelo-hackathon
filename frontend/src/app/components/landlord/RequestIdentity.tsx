import { requestReference, requestTime } from '../../lib/requestIdentity';

export default function RequestIdentity({ id, createdAt }: { id: string; createdAt?: string }) {
  return <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-normal text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta" data-testid={`request-identity-${id}`}>
    <span className="font-mono" title={`Request ID: ${id}`}>{requestReference(id)}</span>
    {createdAt ? <time dateTime={createdAt} title={new Date(createdAt).toString()}>Submitted {requestTime(createdAt)}</time> : null}
  </span>;
}

export function NewRequestBadge() {
  return <span title="Submitted in the last 24 hours and not yet opened on this browser" className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700 in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-pill in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-pill">New</span>;
}
