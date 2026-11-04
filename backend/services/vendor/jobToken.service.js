// Minting and resolution of JobToken — the vendor's credential for a live job.
//
// Reuses the same primitives vendorOutreach.service has always used: 256 bits
// of randomness, sha256 at rest, the raw value never persisted and never logged.
// What is new is the "job" scope, which outlives the outreach row so a vendor
// standing in the unit does not lose their link because routing retired the
// offer behind them.

const crypto = require("crypto");
const env = require("../../config/env");
const JobToken = require("../../models/JobToken");
const { JOB_CODE_ALPHABET, JOB_CODE_LENGTH } = require("../../models/JobToken");

const TOKEN_BYTES = 32; // 256 bits

// A JOB-scoped token deliberately has NO clock expiry.
//
// Its lifetime is bounded by the JOB, not by a timer: requireJobToken refuses
// any appointment outside [scheduled, work_verifying] for writes, and
// closeJobCompletion revokes the token outright. A 30-day TTL sat on top of
// that and did nothing except lock vendors out of a job that was still open —
// including out of payout setup, which is only reachable through this link. A
// vendor with money held and no way to enter bank details is a far worse
// outcome than a live credential on a job that is still running.
//
// The backstop below exists only so a job abandoned forever does not leave a
// working credential forever. Nothing a real job reaches.
const JOB_TOKEN_BACKSTOP_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

/** The vendor's post-visit link. Mirrors buildResponseUrl in vendorOutreach. */
function buildJobUrl(rawToken) {
  const base = String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/vendor-job/${rawToken}`;
}

function generateRawToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Crockford base32, drawn from crypto.randomBytes rather than Math.random —
 * this is short enough to be brute-forceable if it were predictable, and the
 * modulo bias of a naive byte-to-index map is avoidable for free by rejecting
 * the tail of the byte range.
 */
function generateJobCode(length = JOB_CODE_LENGTH) {
  const alphabet = JOB_CODE_ALPHABET;
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let code = "";
  while (code.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= limit) continue; // reject, don't fold — folding skews the alphabet
      code += alphabet[byte % alphabet.length];
      if (code.length === length) break;
    }
  }
  return code;
}

/**
 * Mint the job-scoped credential at acceptance.
 *
 * Idempotent via the unique { appointmentId, scope: "job" } partial index:
 * finalizeVendorAcceptance can re-enter after a quota approval, and a second
 * call must return the existing token rather than issuing a second live
 * credential for the same job.
 *
 * Returns { jobToken, rawToken, jobCode, created }. `rawToken` is null when an
 * existing token was found — it is unrecoverable by design, so callers that
 * need to re-send a link must rotate rather than re-read.
 */
async function mintJobToken({
  outreachId,
  requestId,
  appointmentId,
  landlordId,
  identityId = null,
  vendorId = null,
  vendorNameSnapshot = "",
  ttlMs = JOB_TOKEN_BACKSTOP_MS,
}) {
  const existing = await JobToken.findOne({ appointmentId, scope: "job", revokedAt: null });
  if (existing) return { jobToken: existing, rawToken: null, jobCode: existing.jobCode, created: false };

  const rawToken = generateRawToken();
  const jobCode = generateJobCode();

  try {
    const jobToken = await JobToken.create({
      tokenHash: hashToken(rawToken),
      jobCode,
      scope: "job",
      outreachId: outreachId || undefined,
      requestId,
      appointmentId,
      landlordId,
      identityId,
      vendorId,
      vendorNameSnapshot,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return { jobToken, rawToken, jobCode, created: true };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    // Lost the race, or the jobCode collided. Either way the winner is
    // authoritative — never issue a second live credential for one job.
    const winner = await JobToken.findOne({ appointmentId, scope: "job", revokedAt: null });
    if (winner) return { jobToken: winner, rawToken: null, jobCode: winner.jobCode, created: false };
    // A jobCode collision with no appointment winner is vanishingly rare and
    // retryable; surface it rather than pretending it worked.
    throw err;
  }
}

/**
 * Issue a FRESH raw token for a job that already has one.
 *
 * Needed because the raw value is unrecoverable by design — only sha256 is
 * stored — so mintJobToken returns rawToken: null on re-entry. That made the
 * hub structurally incapable of re-issuing a link: it called mint for every
 * active job, got null every time, and told the vendor to use an email they may
 * no longer have. Combined with the old clock expiry, a vendor who lost the
 * email had NO route back to their own job, including to payout setup.
 *
 * Rotation deliberately invalidates the previous link. That is the safer
 * default: the old link is usually sitting in an inbox, and replacing it means
 * a forwarded or leaked copy stops working. Callers must therefore have
 * authenticated the vendor by some other means first — today that is a hub
 * session, which is a stronger credential than the emailed link it replaces.
 */
async function rotateJobToken({ appointmentId, ttlMs = JOB_TOKEN_BACKSTOP_MS }) {
  const rawToken = generateRawToken();

  const rotated = await JobToken.findOneAndUpdate(
    { appointmentId, scope: "job", revokedAt: null },
    {
      $set: {
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + ttlMs),
        lastUsedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!rotated) return { jobToken: null, rawToken: null };
  return { jobToken: rotated, rawToken };
}

/**
 * Resolve a raw token to a live job credential, bumping usage.
 * Returns null for every failure mode — the caller must not distinguish them,
 * so that "never existed" and "retired" are indistinguishable to a probe.
 */
async function resolveJobToken(rawToken, { scope = "job", now = new Date() } = {}) {
  const raw = String(rawToken || "");
  if (!raw) return null;

  const jobToken = await JobToken.findOne({ tokenHash: hashToken(raw), scope });
  if (!jobToken) return null;
  if (jobToken.revokedAt) return null;
  if (jobToken.expiresAt && jobToken.expiresAt < now) return null;

  await JobToken.updateOne(
    { _id: jobToken._id },
    { $set: { lastUsedAt: now }, $inc: { usedCount: 1 } }
  );
  return jobToken;
}

/**
 * Retire the credential. $unset rather than null so the partial unique indexes
 * stop covering the row — see the index comments on the model.
 */
async function revokeJobToken({ appointmentId, jobTokenId }, { now = new Date() } = {}) {
  const filter = jobTokenId ? { _id: jobTokenId } : { appointmentId, scope: "job" };
  return JobToken.updateOne(filter, {
    $set: { revokedAt: now },
    $unset: { tokenHash: 1, jobCode: 1 },
  });
}

module.exports = {
  hashToken,
  buildJobUrl,
  generateRawToken,
  generateJobCode,
  mintJobToken,
  rotateJobToken,
  resolveJobToken,
  revokeJobToken,
  JOB_TOKEN_BACKSTOP_MS,
};
