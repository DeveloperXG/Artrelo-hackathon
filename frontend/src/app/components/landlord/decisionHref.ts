/**
 * Where a decision's "open" button lands. Every decision on this page is about
 * a vendor (who to contact, a booking, an invoice), and on the request page all
 * of that lives in the Vendor Routing tab — Overview is the tenant's report.
 * A paused request also jumps to the panel that says what to do next, so
 * "Choose vendor" arrives at the choice rather than at the top of the page.
 */
/**
 * The central Decisions page focused on one request's decision card. The one
 * link every "review this decision" entry point uses (request routing summary,
 * Iris activity), so all of them act on the same pending approval.
 */
export function decisionsFocusHref(requestId: string) {
  return `/dashboard/decisions?${new URLSearchParams({ request: requestId }).toString()}`;
}

export function decisionHref(requestId: string, { paused = false }: { paused?: boolean } = {}) {
  const params = new URLSearchParams({ tab: 'routing' });
  if (paused) params.set('focus', 'next-steps');
  return `/dashboard/requests/${requestId}?${params.toString()}`;
}
