type ReadyTriage = {
  readyToSubmit?: boolean;
  intakeStatus?: string;
  additionalNotes?: string;
};

const SUBMIT_NOW = 'Please submit this request now so your property manager can review it immediately.';
const NOTES_ADDED = "Thanks — I'll add that to the additional notes for your property manager.";

function isReady(triage?: ReadyTriage | null) {
  return Boolean(triage && (triage.readyToSubmit || triage.intakeStatus === 'ready_to_submit'));
}

function normalizeNotes(notes?: string) {
  return String(notes || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The line the intake assistant says once it has everything it needs.
 *
 * After the summary locks, anything else the tenant says is folded into
 * `additionalNotes` on the server (applySummaryLock). When that actually grew,
 * tell the tenant where it went. When it did not -- the model dropped a
 * low-value remark like "thanks" -- don't claim it was added.
 */
export function buildReadyReply({
  previous,
  current,
  urgentOrEmergency,
}: {
  previous?: ReadyTriage | null;
  current: ReadyTriage;
  urgentOrEmergency: boolean;
}): string {
  const notesAdded =
    isReady(previous) &&
    isReady(current) &&
    normalizeNotes(current.additionalNotes) !== '' &&
    normalizeNotes(current.additionalNotes) !== normalizeNotes(previous?.additionalNotes);

  if (notesAdded) {
    return `${NOTES_ADDED} ${urgentOrEmergency ? SUBMIT_NOW : "You can submit whenever you're ready."}`;
  }
  return urgentOrEmergency ? SUBMIT_NOW : "I have enough detail to submit this request whenever you're ready.";
}
