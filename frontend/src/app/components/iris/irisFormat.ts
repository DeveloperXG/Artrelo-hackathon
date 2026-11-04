/**
 * Display helpers. Money text normally arrives formatted from the server
 * (Change.before/after, CostCell.text); the only amounts formatted here are
 * verified receipt values, and that is digit placement on integer cents, with
 * no floating point and no arithmetic between amounts.
 */
export function formatMinorCAD(minor: number | null): string {
  if (minor === null) return 'Not set';
  if (!Number.isSafeInteger(minor) || minor < 0) return 'Unavailable';
  const digits = String(minor).padStart(3, '0');
  const dollars = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `CAD ${dollars}.${digits.slice(-2)}`;
}

/** Mirror the server's humanInstant: explicit record zone, otherwise labelled UTC. */
export function formatTime(iso: string | null, timeZone: string | null = 'UTC'): string {
  if (!iso) return 'Unknown time';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  let zone = timeZone || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); } catch { zone = 'UTC'; }
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: zone, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date)} ${zone}`;
}

export const onOff = (value: boolean) => (value ? 'On' : 'Off');

/** Enter sends; Shift+Enter is a new line; Enter that ends an IME composition does nothing. */
export function shouldSubmit(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }) {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  // keyCode 229 is the IME "process" key some browsers report instead of isComposing.
  if (event.isComposing || event.keyCode === 229) return false;
  return true;
}
