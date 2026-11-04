const Vendor = require("../../models/Vendor");
const providerRegistry = require("./providers/vendorProviderRegistry.service");
const { normalizeVendorOption } = require("./providerShapes.service");
const {
  resolveRequestCity,
  applyHardConstraints,
  scoreEligibleCandidates,
  resolveNeededCategory,
  evaluateHardConstraints,
} = require("./vendorScoring.service");
const { resolveQuotaLimit } = require("./routingDecision.service");
const { buildVendorMessageDraft } = require("./vendorMessageDraft.service");
const {
  getReasonLabel,
} = require("./vendorServices.service");
const env = require("../../config/env");
const { resolveOutreachTier, buildOfferedWindows } = require("./vendorOutreachPolicy.service");
const { formatHours } = require("./vendorHours");
const { loadPaidJobTotals, paidJobEstimate } = require("./vendorCostHistory.service");
const { guardAutopilotDecision } = require("./autopilotPolicy.service");
const { screenCandidate } = require("./routingCheckpoint.service");

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function buildCandidateKey(candidate = {}) {
  return `${candidate.providerName || "manual"}__${candidate.providerVendorId || candidate.vendorId || "unknown"}`;
}

function buildWhyRecommended(candidate = {}) {
  const reasons = [];
  if (candidate.source === "preset") reasons.push("landlord preset vendor");
  if (candidate.reliabilityScore >= 85) reasons.push("strong reliability history");
  if (candidate.avgResponseMinutes > 0 && candidate.avgResponseMinutes <= 60) {
    reasons.push("fast response time");
  }
  if (candidate.emergencyAvailable) reasons.push("emergency coverage");
  if (candidate.verificationStatus === "trusted") reasons.push("trusted profile");

  return reasons.length ? `Recommended because of ${reasons.join(", ")}.` : "Recommended after deterministic scoring.";
}

// Contact block on a ledger entry. The snapshot is returned to the landlord UI,
// so the address itself is only ever exposed masked (see maskEmail in
// vendorOutreach.service); `hasEmail` is what the UI gates the outreach CTA on.
function buildCandidateContact(candidate = {}) {
  return {
    email: candidate.email || null,
    phone: candidate.phone || null,
    hasEmail: Boolean(candidate.email),
  };
}

// Derived read-cache of the VendorOutreach document that owns this candidate's
// outreach lifecycle. Values are plain JSON only — the snapshot is round-tripped
// through JSON.parse(JSON.stringify(...)), which would degrade Dates/ObjectIds.
function buildInitialOutreachState() {
  return {
    status: "not_sent",
    outreachId: null,
    attempt: 0,
    channel: "email",
    toEmailMasked: null,
    tier: null,
    sentAt: null,
    lastAttemptAt: null,
    firstViewedAt: null,
    respondedAt: null,
    responseDeadlineAt: null,
    deliveryError: null,
    decision: null,
    quotaCheck: null,
  };
}

function buildRequestContext(request, property, unit, policy) {
  // The structured incident record is the canonical source; fall back to the legacy
  // `ai`/request fields so older requests (no incident record) still route.
  const incident = request.incidentRecord || null;
  return {
    request,
    property,
    unit,
    policy,
    requestId: request._id?.toString?.() || request._id,
    landlordId: request.landlordId?.toString?.() || request.landlordId,
    category: request.category,
    subcategory: incident?.subcategory || null,
    vendorTypeNeeded:
      request.vendorTypeNeeded || incident?.trade || request.ai?.suggestedVendorType || null,
    urgency: request.urgency,
    severity: incident?.severity || request.ai?.severity || request.severityOverride || 3,
    costTier: incident?.costTier || null,
    emergency: Boolean(incident?.emergency) || request.urgency === "emergency",
    // Evidence quality drives routing CONFIDENCE (Stage 6), not vendor ranking; carried
    // here so downstream/diagnostics can see it.
    evidenceConfidencePenalty: Boolean(incident?.evidence?.confidencePenalty),
    incidentConfidence:
      typeof incident?.confidence?.overall === "number" ? incident.confidence.overall : null,
    city: resolveRequestCity({ property }),
    requestCreatedAt: request.createdAt,
  };
}

// The vendors a landlord's requests can be routed to. Exported because
// routingSetup.service counts the same set to tell the landlord how many
// vendors a request can actually reach -- two hand-copied filters would drift.
function routableVendorFilter(landlordId) {
  return {
    landlordId,
    status: "active",
    source: { $in: ["preset", "manual_dispatch"] },
    // Belt and braces: seeded demo rows were never landlord-scoped, but a
    // demo vendor must not be recommended even if one ever carries a
    // landlordId -- its outreach email went to a shared real inbox.
    isDemoVendor: { $ne: true },
  };
}

async function loadPresetCandidates({ request, vendorRepository = Vendor }) {
  const rows = await vendorRepository.find(routableVendorFilter(request.landlordId)).lean();

  return rows.map((row) =>
    normalizeVendorOption({
      ...row,
      providerName: row.source === "manual_dispatch" ? "manual_dispatch" : "preset",
      providerVendorId: row.providerVendorId || row._id?.toString?.(),
    })
  );
}

async function enrichCandidates({
  requestContext,
  candidates,
  registry = providerRegistry,
  paidJobTotals = new Map(),
  now = new Date(),
}) {
  const extrasByKey = {};
  const trade = resolveNeededCategory(requestContext);
  // The same tier outreach will use, so the slots previewed here are the
  // slots the vendor would actually be offered if contacted now.
  const tier = resolveOutreachTier(requestContext.request || {});

  for (const candidate of candidates) {
    const key = candidate.providerName + "::" + candidate.providerVendorId;
    const isPresetCandidate = candidate.source === "preset";
    const provider =
      isPresetCandidate || candidate.providerName === "preset"
        ? null
        : registry.getVendorProvider(candidate.providerName);

    // A network vendor's estimate is what they have actually been paid for
    // this trade, or nothing at all until they have been. It used to be
    // hourlyRate..hourlyRate+75, which no form sets, so every new vendor
    // claimed "$0-75". See vendorCostHistory.service.js.
    const priceEstimate = provider
      ? await provider.estimatePrice(requestContext, candidate)
      : paidJobEstimate({
          totals: paidJobTotals,
          vendorId: candidate.vendorId,
          trade,
          providerVendorId: candidate.providerVendorId,
        });

    // Built from the vendor's hours of operation by the same function
    // outreach uses (it used to be [] for every network vendor).
    const availabilitySlots = provider
      ? await provider.getAvailability(candidate, requestContext)
      : buildOfferedWindows({ tier, now, vendor: candidate, timeZone: env.outreach_timezone }).map((slot) => ({
          ...slot,
          start: slot.start ? new Date(slot.start).toISOString() : null,
          end: slot.end ? new Date(slot.end).toISOString() : null,
        }));

    extrasByKey[key] = {
      priceEstimate,
      availabilitySlots,
    };
  }

  return extrasByKey;
}

function summarizeCommonExclusionReasons(ledger = []) {
  const counts = {};
  ledger
    .filter((candidate) => candidate.state === "excluded")
    .forEach((candidate) => {
      (candidate.reasonCodes || []).forEach((reasonCode) => {
        counts[reasonCode] = (counts[reasonCode] || 0) + 1;
      });
    });

  return Object.entries(counts)
    .map(([code, count]) => ({
      code,
      label: getReasonLabel(code),
      count,
    }))
    .sort((left, right) => right.count - left.count);
}

function deriveOutcomeCode({
  discoveredCount,
  vendorTypeNeeded,
  serviceMatchedCount,
  eligibleCount,
  contactableCount = eligibleCount,
  serviceMatchedEvaluations,
}) {
  if (discoveredCount === 0) return "no_candidates_discovered";
  if (!vendorTypeNeeded) return "vendor_service_unresolved";
  if (serviceMatchedCount === 0) return "no_service_matches";
  if (eligibleCount === 0) {
    const onlyLocationFailures =
      serviceMatchedEvaluations.length > 0 &&
      serviceMatchedEvaluations.every(
        (entry) =>
          entry.reasonCodes.length > 0 &&
          entry.reasonCodes.every((reasonCode) =>
            ["outside_service_area", "no_emergency_coverage"].includes(reasonCode)
          )
      );
    return onlyLocationFailures ? "no_location_matches" : "all_candidates_excluded";
  }
  // Vendors passed every constraint, and every one of them has already been
  // contacted on this request (declined, turned down, timed out). This read
  // "ready_to_route" -- beside a decision saying no vendor passed at all.
  if (contactableCount === 0) return "all_vendors_contacted";
  return "ready_to_route";
}

function deriveRecommendedNextAction(outcomeCode) {
  if (outcomeCode === "vendor_service_unresolved") {
    return "Clarify the required vendor service or use manual assignment.";
  }
  if (outcomeCode === "no_candidates_discovered") {
    return "Add a vendor who covers this job to your vendor network, or assign one manually.";
  }
  if (outcomeCode === "no_service_matches") {
    return "Use manual assignment or add vendors who provide this service.";
  }
  if (outcomeCode === "no_location_matches") {
    return "Use manual assignment or add vendors who serve this location.";
  }
  if (outcomeCode === "all_candidates_excluded") {
    return "Review the exclusion reasons and use manual assignment if override is justified.";
  }
  if (outcomeCode === "all_vendors_contacted") {
    return "Every vendor who can take this job has already been contacted. Add a vendor, then search again.";
  }
  return "Review the ranked candidates and choose the next manager action.";
}

function buildExcludedLedgerEntry(candidate, evaluation) {
  return {
    candidateKey: buildCandidateKey(candidate),
    vendorId: candidate.vendorId || null,
    providerName: candidate.providerName,
    providerVendorId: candidate.providerVendorId,
    name: candidate.name,
    category: candidate.category,
    service: candidate.service,
    services: candidate.services || [],
    specialties: candidate.specialties,
    city: candidate.city,
    serviceAreas: candidate.serviceAreas,
    rating: candidate.rating,
    reliabilityScore: candidate.reliabilityScore,
    avgResponseMinutes: candidate.avgResponseMinutes,
    hourlyRate: candidate.hourlyRate,
    emergencyAvailable: candidate.emergencyAvailable,
    insuranceVerified: candidate.insuranceVerified,
    licenseVerified: candidate.licenseVerified,
    candidateSource: candidate.source,
    source: candidate.source,
    isDemoVendor: candidate.isDemoVendor,
    verificationStatus: candidate.verificationStatus,
    contact: buildCandidateContact(candidate),
    outreach: buildInitialOutreachState(),
    evaluationStage: "hard_constraints",
    state: "excluded",
    displayGroup: "excluded",
    score: null,
    scoreBreakdown: null,
    reasonCodes: evaluation.reasonCodes,
    humanReadableReasons: evaluation.humanReadableReasons,
    whyRecommended: null,
    priceEstimate: null,
    availabilitySlots: [],
    draftMessage: null,
    holdReason: null,
    contactApproval: {
      status: "pending",
      approvedAt: null,
      approvedBy: null,
    },
    manualSelection: {
      status: "not_selected",
      selectedAt: null,
      selectedBy: null,
      selectionMethod: null,
      overrideReason: null,
      overriddenConstraints: [],
    },
    managerDecision: {
      status: "pending",
      actedAt: null,
      actedBy: null,
    },
  };
}

// Vendors who already closed an outreach round on THIS request. A regeneration
// must not offer them again: the decline removed them as an option for this
// request specifically, and re-approving one collides with the unique index on
// { requestId, candidateKey, attempt }. That collision is swallowed as
// non-fatal by approveVendorRecommendationContact, which left the request
// holding an active candidate that could never respond and no way to move on.
//
// Keyed on the LATEST row per candidateKey, mirroring projectOutreachOntoSnapshot,
// so a resend that is still open supersedes the attempt before it.
const CLOSED_OUTREACH_STATUSES = ["declined", "expired", "superseded", "revoked"];

function buildClosedOutreachIndex(priorOutreach = []) {
  const latestByKey = new Map();
  [...priorOutreach]
    .sort(
      (left, right) =>
        Number(right.attempt || 0) - Number(left.attempt || 0) ||
        new Date(right.createdAt || 0) - new Date(left.createdAt || 0)
    )
    .forEach((row) => {
      if (!latestByKey.has(row.candidateKey)) latestByKey.set(row.candidateKey, row);
    });

  const index = {};
  latestByKey.forEach((row, candidateKey) => {
    if (!CLOSED_OUTREACH_STATUSES.includes(row.status)) return;
    const when = row.respondedAt || row.sentAt || row.createdAt;
    const on = when ? ` on ${new Date(when).toLocaleDateString("en-CA")}` : "";
    const declineReason = row.response?.declineReason ? `: ${row.response.declineReason}` : "";

    if (row.status === "declined") {
      index[candidateKey] = {
        reasonCode: "vendor_declined",
        label: `Vendor declined${on}${declineReason}`,
      };
    } else if (row.status === "expired") {
      index[candidateKey] = {
        reasonCode: "vendor_no_response",
        label: `No response within the agreed window${on}`,
      };
    } else {
      index[candidateKey] = {
        reasonCode: "outreach_closed",
        label: `Outreach closed (${row.status})${on}`,
      };
    }
  });

  return index;
}

function buildScoredLedgerEntries({
  request,
  scoredCandidates,
  extrasByKey,
  topK = 3,
  closedOutreachByKey = {},
  trade = null,
}) {
  // Ranks only the vendors still in play, so a vendor who already declined can
  // never occupy one of the three Recommended slots.
  let liveRank = 0;

  return scoredCandidates.map((candidate) => {
    const key = candidate.providerName + "::" + candidate.providerVendorId;
    const extras = extrasByKey[key] || {};
    const candidateKey = buildCandidateKey(candidate);
    const closed = closedOutreachByKey[candidateKey] || null;
    const isRecommended = !closed && liveRank++ < topK;

    return {
      candidateKey,
      vendorId: candidate.vendorId || null,
      providerName: candidate.providerName,
      providerVendorId: candidate.providerVendorId,
      name: candidate.name,
      category: candidate.category,
      service: candidate.service,
      services: candidate.services || [],
      specialties: candidate.specialties,
      city: candidate.city,
      serviceAreas: candidate.serviceAreas,
      rating: candidate.rating,
      reliabilityScore: candidate.reliabilityScore,
      avgResponseMinutes: candidate.avgResponseMinutes,
      hourlyRate: candidate.hourlyRate,
      emergencyAvailable: candidate.emergencyAvailable,
      insuranceVerified: candidate.insuranceVerified,
      licenseVerified: candidate.licenseVerified,
      candidateSource: candidate.source,
      source: candidate.source,
      isDemoVendor: candidate.isDemoVendor,
      verificationStatus: candidate.verificationStatus,
      contact: buildCandidateContact(candidate),
      outreach: buildInitialOutreachState(),
      evaluationStage: "scored",
      state: closed ? "excluded" : isRecommended ? "recommended" : "pending",
      displayGroup: closed ? "excluded" : isRecommended ? "recommended" : "eligible_not_top_k",
      score: candidate.score,
      scoreBreakdown: candidate.scoreBreakdown,
      reasonCodes: closed ? [closed.reasonCode] : [],
      humanReadableReasons: closed ? [closed.label] : [],
      whyRecommended: buildWhyRecommended(candidate),
      priceEstimate: extras.priceEstimate || null,
      availabilitySlots: extras.availabilitySlots || [],
      // e.g. "24/7", "Mon–Fri 9:00–17:00". Landlord-only snapshot field.
      hoursLabel: formatHours(candidate.operatingHours) || candidate.businessHours || null,
      // No slot in the draft: it is stored and may be sent days later. The
      // email lists windows computed at send time.
      draftMessage: buildVendorMessageDraft({
        request,
        priceEstimate: extras.priceEstimate,
        trade,
      }),
      holdReason: null,
      contactApproval: {
        status: "pending",
        approvedAt: null,
        approvedBy: null,
      },
      manualSelection: {
        status: "not_selected",
        selectedAt: null,
        selectedBy: null,
        selectionMethod: null,
        overrideReason: null,
        overriddenConstraints: [],
      },
      managerDecision: {
        status: "pending",
        actedAt: null,
        actedBy: null,
      },
    };
  });
}

function groupLedger(ledger = []) {
  return {
    recommendations: ledger.filter((candidate) => candidate.displayGroup === "recommended"),
    eligibleButNotTopCandidates: ledger.filter(
      (candidate) => candidate.displayGroup === "eligible_not_top_k"
    ),
    excludedCandidates: ledger.filter((candidate) => candidate.displayGroup === "excluded"),
    heldCandidates: ledger.filter((candidate) => candidate.displayGroup === "held"),
  };
}

async function generateVendorRecommendations(
  {
    request,
    property,
    unit,
    policy,
    priorOutreach = [],
  },
  deps = {}
) {
  const registry = deps.registry || providerRegistry;
  const vendorRepository = deps.vendorRepository || Vendor;
  const requestContext = buildRequestContext(request, property, unit, policy);

  const presetCandidates = await loadPresetCandidates({
    request,
    vendorRepository,
  });

  // Only the landlord's own network. There used to be a second source here --
  // the mock provider, mixed in on demand and FORCED in whenever the network
  // was empty -- so an empty network still produced confident recommendations
  // of vendors who did not exist. An empty network now says so
  // (no_candidates_discovered) and the UI points the landlord at adding one.
  const discoveredCandidates = presetCandidates;
  const vendorTypeNeeded = resolveNeededCategory(requestContext);

  const evaluations = discoveredCandidates.map((candidate) =>
    evaluateHardConstraints(requestContext, candidate)
  );

  const serviceMatchedEvaluations = evaluations.filter((entry) =>
    !(entry.reasonCodes || []).includes("service_mismatch") &&
    !(entry.reasonCodes || []).includes("vendor_service_unresolved")
  );

  const eligibleCandidates = evaluations
    .filter((entry) => entry.eligible)
    .map((entry) => entry.candidate);
  // One query for every eligible vendor's paid history. Non-fatal: a missing
  // estimate is honest, a failed generation is not.
  let paidJobTotals = new Map();
  try {
    paidJobTotals = await (deps.loadPaidJobTotals || loadPaidJobTotals)({
      landlordId: request.landlordId,
      vendorIds: eligibleCandidates.map((candidate) => candidate.vendorId),
    });
  } catch (err) {
    console.error("[generateVendorRecommendations] paid-job history unavailable", err?.message || err);
  }

  const extrasByKey = await enrichCandidates({
    requestContext,
    candidates: eligibleCandidates,
    registry,
    paidJobTotals,
    now: deps.now || new Date(),
  });
  const scoredCandidates = scoreEligibleCandidates(requestContext, eligibleCandidates, extrasByKey);

  const costForCandidate = (candidate) => {
    const key = candidate.providerName + "::" + candidate.providerVendorId;
    return Number(extrasByKey[key]?.priceEstimate?.amountHigh);
  };

  const eligibleHighs = eligibleCandidates
    .map(costForCandidate)
    .filter((amount) => Number.isFinite(amount) && amount > 0);

  const lowestEligibleCost = eligibleHighs.length ? Math.min(...eligibleHighs) : 0;

  // Everything the routing DECISION reasons about has to come from vendors who
  // can still be contacted. Naming a vendor who already declined â€” or counting
  // them towards "there are options here" â€” produces a decision the manager has
  // no way to act on.
  const closedOutreachByKey = buildClosedOutreachIndex(priorOutreach);
  const contactableScored = scoredCandidates.filter(
    (candidate) => !closedOutreachByKey[buildCandidateKey(candidate)]
  );

  // Prefer the highest-scored candidate that fits the quota; only when none fit
  // does bestCandidate become an over-quota pick, which trips request_quota_increase.
  const quotaLimit = resolveQuotaLimit(policy, request);
  // An unknown cost (no paid history yet) is not over quota: the vendor's real
  // quote is checked against the quota when they accept (quotaCheck). Treating
  // it as over would hand the pick to any priced vendor regardless of score.
  // No quota set: nothing to filter by. Every candidate is eligible on score,
  // and the routing decision (quota_not_set) makes the manager approve contact.
  const withinQuotaBest = contactableScored.find((candidate) => {
    if (quotaLimit === null) return true;
    const high = costForCandidate(candidate);
    return !Number.isFinite(high) || high <= quotaLimit;
  });
  const bestCandidate = withinQuotaBest || contactableScored[0] || null;

  const bestExtras = bestCandidate
    ? extrasByKey[bestCandidate.providerName + "::" + bestCandidate.providerVendorId]
    : null;

  const screening = screenCandidate({
    request,
    candidate: bestCandidate,
    policy,
    previousSnapshot: request.vendorRecommendationSnapshot,
    priceEstimate: bestExtras?.priceEstimate,
    eligibleCount: contactableScored.length,
    // Eligible vendors exist but all were tried: say that, not "none passed".
    alreadyContactedCount: scoredCandidates.length - contactableScored.length,
    vendorTypeNeeded,
    lowestEligibleCost,
  });
  let decision = screening.decision;

  const scoredLedger = buildScoredLedgerEntries({
    request,
    // The policy pick must also lead the visible recommendations, including
    // when an affordable lower-scored vendor displaced the highest scorer.
    scoredCandidates: bestCandidate
      ? [bestCandidate, ...scoredCandidates.filter((c) => buildCandidateKey(c) !== buildCandidateKey(bestCandidate))]
      : scoredCandidates,
    extrasByKey,
    topK: 3,
    closedOutreachByKey,
    trade: vendorTypeNeeded,
  });
  const excludedLedger = evaluations
    .filter((entry) => !entry.eligible)
    .map((entry) => buildExcludedLedgerEntry(entry.candidate, entry));

  const candidateLedger = [...scoredLedger, ...excludedLedger];
  decision.candidateKey = bestCandidate ? buildCandidateKey(bestCandidate) : null;
  if (request.initialRouting) {
    decision = guardAutopilotDecision({ request, policy, candidate: scoredLedger[0], decision });
  }
  const commonExclusionReasons = summarizeCommonExclusionReasons(candidateLedger);
  const outcomeCode = deriveOutcomeCode({
    discoveredCount: discoveredCandidates.length,
    vendorTypeNeeded,
    serviceMatchedCount: serviceMatchedEvaluations.length,
    eligibleCount: eligibleCandidates.length,
    contactableCount: contactableScored.length,
    serviceMatchedEvaluations,
  });
  const groups = groupLedger(candidateLedger);

  return {
    version: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    defaultProvider: registry.getDefaultProviderName(),
    requestSnapshot: {
      requestId: request._id?.toString?.() || request._id,
      category: request.category,
      urgency: request.urgency,
      vendorTypeNeeded,
      propertyName: property?.name || "",
      propertyAddress: property?.address || "",
      unitNumber: unit?.unitNumber || "",
      severity: request.ai?.severity || request.severityOverride || null,
    },
    decision,
    routingCheckpoints: screening.routingCheckpoints,
    diagnostics: {
      discoveredCount: discoveredCandidates.length,
      serviceMatchedCount: serviceMatchedEvaluations.length,
      eligibleCount: eligibleCandidates.length,
      // Eligible minus everyone who already closed a round on this request.
      contactableCount: contactableScored.length,
      recommendedCount: groups.recommendations.length,
      outcomeCode,
      commonExclusionReasons,
      recommendedNextAction: deriveRecommendedNextAction(outcomeCode),
    },
    candidateLedger,
    recommendations: groups.recommendations,
    eligibleButNotTopCandidates: groups.eligibleButNotTopCandidates,
    excludedCandidates: groups.excludedCandidates,
    heldCandidates: groups.heldCandidates,
    selectedCandidateKey: null,
    activeCandidateKey: null,
    approvalRequest: null,
  };
}

module.exports = {
  buildCandidateKey,
  buildCandidateContact,
  buildClosedOutreachIndex,
  buildInitialOutreachState,
  buildRequestContext,
  loadPresetCandidates,
  routableVendorFilter,
  groupLedger,
  generateVendorRecommendations,
};
