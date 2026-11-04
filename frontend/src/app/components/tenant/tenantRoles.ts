// Display roles only. Domain selectors still supply the status and exact label.
export function tenantStatusClass(status: string) {
  if (['in_progress','needs_approval','needs_vendor','appeal_pending'].includes(status)) return 'in-[.lichen-d5]:border-transparent in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-pill in-[.lichen-d5]:ring-0';
  if (['approved','contacting_vendor','completed'].includes(status)) return 'in-[.lichen-d5]:border-transparent in-[.lichen-d5]:bg-mist-tint in-[.lichen-d5]:text-mist-text in-[.lichen-d5]:ring-0';
  if (status === 'rejected') return 'in-[.lichen-d5]:border-transparent in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text in-[.lichen-d5]:ring-0';
  return 'in-[.lichen-d5]:border-transparent in-[.lichen-d5]:bg-pill-neutral in-[.lichen-d5]:text-chip-icon in-[.lichen-d5]:ring-0';
}

// Calendar/appointment display only; existing selectors still choose the
// schedule state, exact audience label, available actions and placed geometry.
export function tenantVisitClasses(status: string) {
  const role = ['scheduled','completed'].includes(status) ? 'mist'
    : ['in_review','disputed','failed'].includes(status) ? 'alert'
    : status === 'cancelled' ? 'neutral' : 'lichen';
  const styles = {
    mist: { block:'in-[.lichen-d5]:border-l-mist-text in-[.lichen-d5]:bg-mist-tint', pill:'in-[.lichen-d5]:bg-mist-tint in-[.lichen-d5]:text-mist-text', dot:'in-[.lichen-d5]:bg-mist-text' },
    alert: { block:'in-[.lichen-d5]:border-l-alert-text in-[.lichen-d5]:bg-alert-tint', pill:'in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text', dot:'in-[.lichen-d5]:bg-alert-text' },
    neutral: { block:'in-[.lichen-d5]:border-l-control-border in-[.lichen-d5]:bg-well', pill:'in-[.lichen-d5]:bg-pill-neutral in-[.lichen-d5]:text-chip-icon', dot:'in-[.lichen-d5]:bg-meta' },
    lichen: { block:'in-[.lichen-d5]:border-l-lichen-icon in-[.lichen-d5]:bg-lichen-tint', pill:'in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-text', dot:'in-[.lichen-d5]:bg-lichen-icon' },
  };
  return styles[role];
}
