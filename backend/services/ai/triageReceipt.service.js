// A browser round-trip is evidence, not authority. Receipts attest to the exact
// server result and tenant input without carrying their private text in a token.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../../config/env");

const PURPOSE = "artrelo:triage:v1";
const TTL_SECONDS = 2 * 60 * 60;
function canonical(value) {
  if (value?.toJSON) value = value.toJSON();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => [k, canonical(value[k])]));
  }
  return value;
}
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const photosOf = (photos = []) => [...new Set(photos.map((p) => String(p).trim()).filter(Boolean))].sort();
function userDescription(history = [], message = "") {
  const turns = history.filter((m) => !["ai", "assistant"].includes(m.role))
    .map((m) => String(m.content || "").trim()).filter(Boolean);
  if (message.trim() && turns.at(-1) !== message.trim()) turns.push(message.trim());
  return turns.join("\n");
}
function issueTriageReceipt({ tenantId, triage, message = "", conversationHistory = [], photos = [], now = Date.now() }) {
  if (!env.jwt_secret || !tenantId) return null;
  return jwt.sign({
    input: digest({ description: userDescription(conversationHistory, message), photos: photosOf(photos) }),
    result: digest(triage), iat: Math.floor(now / 1000),
  }, env.jwt_secret, { algorithm: "HS256", audience: PURPOSE, subject: String(tenantId), expiresIn: TTL_SECONDS });
}
function verifyTriageReceipt({ receipt, tenantId, triage, issueDescription, conversationHistory = [], photos = [], now = Date.now() }) {
  try {
    if (!receipt || !env.jwt_secret) return false;
    const proof = jwt.verify(receipt, env.jwt_secret, {
      algorithms: ["HS256"], audience: PURPOSE, subject: String(tenantId), clockTimestamp: Math.floor(now / 1000),
    });
    const description = userDescription(conversationHistory);
    return description === String(issueDescription || "").trim() &&
      proof.input === digest({ description, photos: photosOf(photos) }) && proof.result === digest(triage);
  } catch { return false; }
}

// Only persisted, routing-relevant fields: explicit defaults survive Mongoose
// casting. Re-triaging/editing a request invalidates this attestation.
function routingDigest(request) {
  const ai = request.ai || {};
  const incident = request.incidentRecord || {};
  return digest({
    description: request.issueDescription, title: request.issueTitle, category: request.category,
    urgency: request.urgency, vendorType: request.vendorTypeNeeded || null,
    responsibility: request.responsibility || "unknown", photos: photosOf(request.photos || []),
    severityOverride: request.severityOverride || null,
    ai: [ai.urgency || null, ai.severity || null, Boolean(ai.emergencyServicesRecommended)],
    incident: [incident.trade || null, incident.severity || null, Boolean(incident.emergency),
      incident.responsibility || "unknown", incident.costTier || "Unknown", Number(incident.confidence?.overall || 0),
      Boolean(incident.safety?.lifeSafetyConcern), Boolean(incident.safety?.activeDamage)],
    readiness: [request.routingReadiness?.state || null, Boolean(request.routingReadiness?.blocking)],
  });
}
const hasRoutingAuthority = (request) => Boolean(request.routingAuthority?.digest &&
  request.routingAuthority.digest === routingDigest(request));
module.exports = { issueTriageReceipt, verifyTriageReceipt, userDescription, digest, routingDigest, hasRoutingAuthority, TTL_SECONDS };
