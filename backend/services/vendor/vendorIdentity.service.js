// Resolution of a real-world contractor to a single global VendorIdentity.
//
// Called at first outreach send. New booking offers require the resolved
// identity for calendar coordination; older callers may still fail softly.
//
// The hard constraint is the pair of unique indexes on VendorIdentity
// (phoneE164, emailNormalized). Every write here is either guarded or
// best-effort, because a losing race must degrade to "read the winner", never
// to a 500 on the vendor-contact-approval path.

const VendorIdentity = require("../../models/VendorIdentity");

// The app is CAD / America-Regina, so a bare 10-digit number is North American.
// This is a deliberate simplification, not a general E.164 parser: there is no
// libphonenumber dependency and adding one to normalize seed data is not worth
// the weight. Anything it cannot confidently normalize returns null, which
// downgrades the identity to email-keyed rather than producing a wrong key.
const DEFAULT_COUNTRY_CODE = "1";

/**
 * "(306) 555-8842" -> "+13065558842". Returns null when the input cannot be
 * normalized with confidence — callers treat null as "no phone", never as an
 * error.
 */
function normalizePhoneE164(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  if (hasPlus) {
    // Already international. E.164 allows at most 15 digits.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  if (digits.length === 10) return `+${DEFAULT_COUNTRY_CODE}${digits}`;
  if (digits.length === 11 && digits.startsWith(DEFAULT_COUNTRY_CODE)) return `+${digits}`;

  // 7-digit local numbers have no area code, so they cannot identify anyone.
  // Longer strings without a leading + are ambiguous. Both are refused.
  return null;
}

function normalizeEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  return email;
}

/**
 * Phone wins when present: an email address is far more likely to be shared
 * (dispatch@, info@) than a mobile number.
 */
function resolveIdentityKey({ phone, email }) {
  const phoneE164 = normalizePhoneE164(phone);
  const emailNormalized = normalizeEmail(email);
  return {
    phoneE164,
    emailNormalized,
    identityKey: phoneE164 || emailNormalized || null,
  };
}

function hasProviderRef(identity, providerName, providerVendorId) {
  return (identity.providerRefs || []).some(
    (ref) => ref.providerName === providerName && ref.providerVendorId === providerVendorId
  );
}

/**
 * Fills in details we have learned since the identity was created. Every write
 * is best-effort: enriching is a nice-to-have, and a unique-index collision here
 * means another identity already owns that phone/email, which mergeIdentities
 * resolves later. It must never propagate.
 */
async function enrichIdentity(identity, { phoneE164, emailNormalized, name, providerName, providerVendorId }) {
  const patch = {};

  if (phoneE164 && !identity.phoneE164) patch.phoneE164 = phoneE164;
  if (emailNormalized && !identity.emailNormalized) patch.emailNormalized = emailNormalized;
  if (name && !identity.displayName) patch.displayName = String(name).trim();

  const addRef =
    providerName && providerVendorId && !hasProviderRef(identity, providerName, providerVendorId);

  if (!Object.keys(patch).length && !addRef) return identity;

  const update = {};
  if (Object.keys(patch).length) update.$set = patch;
  if (addRef) update.$addToSet = { providerRefs: { providerName, providerVendorId } };

  try {
    const updated = await VendorIdentity.findOneAndUpdate({ _id: identity._id }, update, { new: true });
    return updated || identity;
  } catch (err) {
    if (err?.code === 11000) {
      // Another identity already holds this phone or email. Leave both alone —
      // findMergeCandidates surfaces it for an explicit, audited merge.
      console.warn("[vendorIdentity] enrich collided, merge candidate:", identity._id.toString());
      return identity;
    }
    throw err;
  }
}

/**
 * Find-or-create the global identity for a contractor.
 *
 * Returns { identity, created, mergeCandidateId }. `identity` is null when there
 * is no usable contact information at all — callers must tolerate that rather
 * than treating it as a failure.
 *
 * `mergeCandidateId` is set when the phone and the email resolve to two
 * DIFFERENT existing identities. It does not merge them: merging is destructive
 * and rewrites payout routing, so it stays an explicit, audited operation.
 */
async function ensureVendorIdentity({ phone, email, name, providerName, providerVendorId } = {}) {
  const { phoneE164, emailNormalized, identityKey } = resolveIdentityKey({ phone, email });
  if (!identityKey) return { identity: null, created: false, mergeCandidateId: null };

  const [byPhone, byEmail] = await Promise.all([
    phoneE164 ? VendorIdentity.findOne({ phoneE164 }) : null,
    emailNormalized ? VendorIdentity.findOne({ emailNormalized }) : null,
  ]);

  // Phone is the stronger key, so it wins the tie and the email-keyed row
  // becomes the merge candidate.
  const existing = byPhone || byEmail;
  const mergeCandidateId =
    byPhone && byEmail && String(byPhone._id) !== String(byEmail._id) ? byEmail._id : null;

  if (existing) {
    const identity = await enrichIdentity(existing, {
      phoneE164,
      emailNormalized: mergeCandidateId ? null : emailNormalized,
      name,
      providerName,
      providerVendorId,
    });
    return { identity, created: false, mergeCandidateId };
  }

  try {
    const identity = await VendorIdentity.create({
      identityKey,
      ...(phoneE164 ? { phoneE164 } : {}),
      ...(emailNormalized ? { emailNormalized } : {}),
      displayName: name ? String(name).trim() : undefined,
      providerRefs:
        providerName && providerVendorId ? [{ providerName, providerVendorId }] : [],
    });
    return { identity, created: true, mergeCandidateId: null };
  } catch (err) {
    if (err?.code !== 11000) throw err;

    // Lost the create race against a concurrent outreach for the same vendor.
    // The winner is authoritative; re-read it. Same idiom as the
    // { requestId, candidateKey, attempt } collision in vendorOutreach.service.
    const winner =
      (phoneE164 && (await VendorIdentity.findOne({ phoneE164 }))) ||
      (emailNormalized && (await VendorIdentity.findOne({ emailNormalized }))) ||
      (await VendorIdentity.findOne({ identityKey }));

    return { identity: winner || null, created: false, mergeCandidateId: null };
  }
}

/**
 * Fold `fromId` into `intoId`. Idempotent and non-destructive: the losing
 * document is kept and tombstoned with `mergedInto` rather than deleted, so any
 * JobCompletion or VendorOutreach still pointing at it remains resolvable.
 *
 * The unique phone/email indexes force the transfer to be an unset-then-set:
 * the winner cannot take a contact value the loser still holds.
 */
async function mergeIdentities({ fromId, intoId }) {
  if (String(fromId) === String(intoId)) return null;

  const [from, into] = await Promise.all([
    VendorIdentity.findById(fromId),
    VendorIdentity.findById(intoId),
  ]);
  if (!from || !into) return null;
  if (from.mergedInto) return into;

  const claimPhone = from.phoneE164 && !into.phoneE164 ? from.phoneE164 : null;
  const claimEmail = from.emailNormalized && !into.emailNormalized ? from.emailNormalized : null;

  const unset = {};
  if (claimPhone) unset.phoneE164 = 1;
  if (claimEmail) unset.emailNormalized = 1;

  // Tombstone first. This releases the contact values from the unique indexes
  // AND makes the loser unreachable, so a concurrent ensureVendorIdentity can
  // no longer resolve to a document that is mid-merge.
  const calendar = require("./vendorCalendar.service");
  const ids = [from._id, into._id].sort((a, b) => String(a).localeCompare(String(b)));
  for (const id of ids) await calendar.ensureCalendar(id);
  const claimed = await require("mongoose").connection.transaction(async session => {
    for (const id of ids) await calendar.lockCalendar(id, session);
    for (const id of ids) {
      const occupied = await calendar.occupied(id, { session });
      if (occupied.some(row => row.appointmentId || new Date(row.end) > new Date())) {
        const error = new Error("Resolve active visits and busy periods before merging vendor identities.");
        error.status = 409; error.code = "active_vendor_calendar"; throw error;
      }
    }
    const changed = await VendorIdentity.updateOne({ _id: from._id, mergedInto: null }, {
      $set: { mergedInto: into._id }, ...(Object.keys(unset).length ? { $unset: unset } : {}),
    }, { session });
    return changed?.matchedCount !== 0;
  });
  if (!claimed) return into;
  // Claim the now-released contact values after commit: Mongo unique keys are
  // not reusable within the transaction that removed them from another row.

  const set = {};
  if (claimPhone) set.phoneE164 = claimPhone;
  if (claimEmail) set.emailNormalized = claimEmail;
  if (!into.displayName && from.displayName) set.displayName = from.displayName;
  // Connect never transfers: a Stripe account is bound to a verified legal
  // identity, and silently repointing payouts is exactly the mistake this
  // function must not make. An operator re-onboards the survivor if needed.

  const merged = await VendorIdentity.findOneAndUpdate(
    { _id: into._id },
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      $inc: {
        "aggregate.completedJobs": from.aggregate?.completedJobs || 0,
        "aggregate.disputedJobs": from.aggregate?.disputedJobs || 0,
        "aggregate.ratingSum": from.aggregate?.ratingSum || 0,
        "aggregate.ratingCount": from.aggregate?.ratingCount || 0,
      },
      $addToSet: { providerRefs: { $each: from.providerRefs || [] } },
    },
    { new: true }
  );

  return merged;
}

/** Follows the mergedInto chain so callers holding a stale id still resolve. */
async function resolveIdentity(identityId, depth = 0) {
  if (!identityId || depth > 5) return null;
  const identity = await VendorIdentity.findById(identityId);
  if (!identity) return null;
  if (!identity.mergedInto) return identity;
  return resolveIdentity(identity.mergedInto, depth + 1);
}

module.exports = {
  normalizePhoneE164,
  normalizeEmail,
  resolveIdentityKey,
  ensureVendorIdentity,
  mergeIdentities,
  resolveIdentity,
};
