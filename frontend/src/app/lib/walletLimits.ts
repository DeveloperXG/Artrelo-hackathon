// Wallet top-up limits and the bank-debit status shape, apart from the form.
//
// Their own module so the Wallet page can name them WITHOUT importing
// WalletDepositForm: that file imports @stripe/stripe-js, which injects
// Stripe.js the moment it is loaded, and a direct-pay landlord's Payments page
// has no business loading a payment script it never uses.

/** Mirrors MIN_CARD_DEPOSIT_CENTS on the server, which stays the authority. */
export const MIN_CARD_DEPOSIT = 20;

/** What the server says this landlord may do with bank top-ups (bankTopUp.service.bankStatusFor). */
export type BankDebitStatus = {
  enabled: boolean;
  saved?: { last4: string | null; institution: string | null } | null;
  blocked?: boolean;
  trusted?: boolean;
  inFlight?: number;
  /** Cleared bank top-ups so far, and how many lift the cap and the one-at-a-time rule. */
  cleared?: number;
  trustedAfter?: number;
  /** The server's own explanation when a bank top-up can't start right now (paused, or one still processing). */
  reason?: string | null;
  minCents?: number;
  /** Per-top-up cap until the first few clear. Null once trusted. */
  capCents?: number | null;
  failureFeeCents?: number;
  disputeFeeCents?: number;
};

export type CardPilot = { amountCents: number; expiresAt: string; reference: string };
export function activeCardPilot(pilot?: CardPilot | null, now = Date.now()): pilot is CardPilot {
  return pilot?.amountCents === 100 && Number.isFinite(Date.parse(pilot.expiresAt)) && Date.parse(pilot.expiresAt) > now;
}
export function validCardAmount(amount: number, pilot?: CardPilot | null, now = Date.now()) {
  return Number.isFinite(amount) && (amount >= MIN_CARD_DEPOSIT || (activeCardPilot(pilot, now) && amount === 1));
}
