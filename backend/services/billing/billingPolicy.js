const crypto = require("crypto");
const { isBetaActive } = require("../beta/beta.service");
const { feeFor } = require("../ledger/serviceFee");
const NOTICE_DAYS = 30, GRACE_DAYS = 14, DAY = 86400_000;
function fail(code, message, status = 409) { return Object.assign(new Error(message), { code, status, statusCode: status }); }
function offerVersion(rate) {
  return `service-billing-2026-10-v1:${crypto.createHash("sha256").update(JSON.stringify({ rate, NOTICE_DAYS, GRACE_DAYS, cadence: "monthly", trigger: "verified_completion" })).digest("hex").slice(0, 12)}`;
}
function readiness({ landlord, account, failedAt, emergency = false, enabled = true, taxReviewed = true, now = new Date() }) {
  if (!enabled) return { allowed: true, chargeable: false, reason: "billing_disabled" };
  if (isBetaActive(landlord?.beta, now)) return { allowed: true, chargeable: false, reason: "beta" };
  if (!taxReviewed) return { allowed: false, reason: "billing_configuration_pending" };
  if (!account?.offer?.noticeSentAt || !account?.agreement?.acceptedAt || !account?.card?.paymentMethodId) return { allowed: false, reason: "billing_setup_required" };
  if (!account.offer.effectiveAt || !Number.isFinite(new Date(account.offer.effectiveAt).getTime())) return { allowed: false, reason: "billing_configuration_pending" };
  if (new Date(account.offer.effectiveAt) > now) return { allowed: false, reason: "billing_notice_period" };
  if (!emergency && failedAt && now - new Date(failedAt) >= GRACE_DAYS * DAY) return { allowed: false, reason: "billing_past_due" };
  return { allowed: true, chargeable: true, reason: null };
}
function feeDecision(snapshot, payableCents) {
  const rate = snapshot?.rate || { flatCents: 0, percent: 0 };
  const listCents = feeFor(rate, payableCents);
  return { listCents, feeCents: snapshot?.chargeable ? listCents : 0,
    waivedReason: snapshot?.chargeable ? null : snapshot?.waivedReason || "pre_activation", basis: rate,
    agreementVersion: snapshot?.agreementVersion || null };
}
function periodStart(now = new Date()) { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); }
module.exports = { NOTICE_DAYS, GRACE_DAYS, DAY, fail, offerVersion, readiness, feeDecision, periodStart };
