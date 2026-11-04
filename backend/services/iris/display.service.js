// Canonical display strings come from typed records; never parse model prose.
function humanInstant(value, timeZone = 'UTC') {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Unknown time';
  let zone = typeof timeZone === 'string' && timeZone ? timeZone : 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); } catch { zone = 'UTC'; }
  const text = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));
  return `${text} ${zone}`;
}
const slotText = (slot, zone) => slot ? humanInstant(slot.start, zone) + ' – ' + humanInstant(slot.end, zone) : 'Not proposed';
function decisionLabel(row) {
  if (row.type === 'cost_review') return row.payload?.stage === 'quote' ? 'Quote scope review' : row.payload?.stage === 'invoice' ? 'Final statement scope review' : 'Scope review (stage not recorded)';
  return ({ vendor_contact_approval: 'Vendor contact', quota_increase: 'Quota increase', first_time_vendor: 'First-time vendor',
    external_vendor_search: 'External vendor search', high_severity: 'High-severity request', tenant_caused_cost: 'Tenant-caused cost',
    completion_review: 'Completion review', other: 'Other review' })[row.type] || 'Recorded decision';
}
module.exports = { humanInstant, slotText, decisionLabel };
