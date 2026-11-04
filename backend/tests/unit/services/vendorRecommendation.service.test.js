// Vendor recommendations: who gets suggested for a job.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * candidates come ONLY from the landlord's own vendor network. There is no
//     mock directory any more, and an empty network must say so rather than
//     recommend vendors who do not exist (it used to force mocks in);
//   * a demo row is never recommended, even if it somehow carries the
//     landlord's id -- its outreach email went to a shared real inbox;
//   * a trade written the way landlords write it ("Pest Control") routes;
//   * a vendor who already declined never comes back, and one with an offer
//     still in flight stays where it was.

const assert = require("assert");
const {
  normalizeVendorOption,
  normalizePriceEstimate,
  normalizeAvailabilitySlot,
} = require("../../../services/vendor/providerShapes.service");
const TaskrabbitProvider = require("../../../services/vendor/providers/TaskrabbitProvider");
const ThumbtackProvider = require("../../../services/vendor/providers/ThumbtackProvider");
const {
  createVendorProviderRegistry,
} = require("../../../services/vendor/providers/vendorProviderRegistry.service");
const { generateVendorRecommendations } = require("../../../services/vendor/vendorRecommendation.service");

// A repository that honours the parts of the Mongo filter loadPresetCandidates
// sends, so the isDemoVendor exclusion is actually exercised rather than
// assumed.
function makeRepository(rows) {
  const matches = (filter, row) =>
    Object.entries(filter).every(([key, condition]) => {
      const value = row[key];
      if (condition && typeof condition === "object" && !Array.isArray(condition)) {
        if ("$in" in condition) return condition.$in.includes(value);
        if ("$ne" in condition) return value !== condition.$ne;
      }
      return String(value) === String(condition);
    });
  return {
    find(filter) {
      return { lean: async () => rows.filter((row) => matches(filter, row)) };
    },
  };
}

const presetRow = (overrides) => ({
  landlordId: "land-1",
  city: "Regina",
  serviceAreas: ["Regina"],
  rating: 4.3,
  reliabilityScore: 83,
  hourlyRate: 98,
  emergencyAvailable: true,
  insuranceVerified: true,
  licenseVerified: true,
  source: "preset",
  verificationStatus: "trusted",
  status: "active",
  ...overrides,
});

// A registry that fails loudly if anything asks it for a provider: with only
// the landlord's own vendors in play, nothing should.
const strictRegistry = {
  getDefaultProviderName: () => "manual_dispatch",
  getDefaultProvider() {
    throw new Error("no provider should be consulted");
  },
  getVendorProvider(name) {
    throw new Error(`no provider should be consulted (asked for ${name})`);
  },
};

// No paid jobs anywhere: the state of every vendor on day one.
const noHistory = async () => new Map();
// vendorId -> trade -> { total, count }, as loadPaidJobTotals returns it.
const history = (entries) => async () =>
  new Map(entries.map(([vendorId, byTrade]) => [vendorId, new Map(Object.entries(byTrade))]));

async function run() {
  /* -------------- 1) Shapes ------------------------------------------- */

  const normalizedVendor = normalizeVendorOption({
    _id: "507f191e810c19729de860ea",
    name: "Trusted Preset Plumbing",
    specialties: ["Plumbing", "Leak repair"],
    serviceArea: "Regina",
    source: "preset",
  });
  assert.strictEqual(normalizedVendor.serviceAreas[0], "Regina");
  assert.deepStrictEqual(normalizedVendor.services, ["Plumbing"]);

  const estimate = normalizePriceEstimate({ providerName: "preset", amountLow: 150, amountHigh: 260 });
  assert.strictEqual(estimate.amountHigh, 260);
  const slot = normalizeAvailabilitySlot({
    providerName: "preset",
    slotId: "slot-1",
    start: "2030-01-07T09:00:00.000Z",
    end: "2030-01-07T11:00:00.000Z",
  });
  assert.strictEqual(slot.available, true);

  /* -------------- 2) The registry has no mock provider ----------------- */

  const registry = createVendorProviderRegistry({ env: {} });
  assert.strictEqual(registry.getDefaultProviderName(), "manual_dispatch", "the default is the landlord's own dispatch");
  assert.throws(() => registry.getVendorProvider("mock"), (err) => err.code === "unknown_provider");
  assert.throws(() => registry.getVendorProvider("taskrabbit"), (err) => err.code === "provider_not_configured");
  await assert.rejects(() => new TaskrabbitProvider().searchVendors({}), (err) => err.code === "provider_not_configured");
  await assert.rejects(() => new ThumbtackProvider().searchVendors({}), (err) => err.code === "provider_not_configured");

  /* -------------- 3) Only the landlord's network is recommended -------- */

  const network = makeRepository([
    presetRow({ _id: "507f191e810c19729de860eb", name: "Trusted Preset Plumbing", specialties: ["Plumbing"] }),
    presetRow({ _id: "507f191e810c19729de860ec", name: "Second Regina Plumbing", specialties: ["Plumbing"], reliabilityScore: 70 }),
    presetRow({ _id: "507f191e810c19729de860ed", name: "Outside City Plumbing", specialties: ["Plumbing"], city: "Winnipeg", serviceAreas: ["Winnipeg"] }),
    presetRow({ _id: "507f191e810c19729de860ee", name: "River Electrical", specialties: ["Electrical"] }),
    // A seeded demo row that somehow carries this landlord's id.
    presetRow({ _id: "507f191e810c19729de860ef", name: "Prairie Demo Plumbing", specialties: ["Plumbing"], isDemoVendor: true, reliabilityScore: 99 }),
    // Another landlord's vendor.
    presetRow({ _id: "507f191e810c19729de860f0", name: "Not Yours Plumbing", specialties: ["Plumbing"], landlordId: "land-2", reliabilityScore: 99 }),
  ]);

  const request = {
    _id: "req-1",
    landlordId: "land-1",
    propertyId: "prop-1",
    unitId: "unit-1",
    tenantId: { firstName: "Taylor", lastName: "Tenant" },
    issueTitle: "Kitchen leak",
    issueDescription: "Water is leaking under the sink.",
    category: "Plumbing",
    vendorTypeNeeded: "Plumbing",
    urgency: "high",
    createdAt: "2030-01-05T12:00:00.000Z",
    ai: { summary: "Kitchen sink leak", severity: 4 },
  };
  const property = { name: "Prairie View", address: "123 Test St, Regina" };
  const unit = { unitNumber: "1A" };
  const policy = { defaultQuota: 350, requireApprovalOverQuota: true, requireApprovalForFirstTimeVendor: true };

  const result = await generateVendorRecommendations(
    { request, property, unit, policy },
    { vendorRepository: network, registry: strictRegistry, loadPaidJobTotals: noHistory }
  );
  const allNames = result.candidateLedger.map((candidate) => candidate.name);
  assert.strictEqual(result.recommendations[0].name, "Trusted Preset Plumbing");
  assert.ok(result.recommendations.every((candidate) => candidate.candidateSource === "preset"));
  assert.ok(!allNames.includes("Prairie Demo Plumbing"), "a demo row is never even a candidate");
  assert.ok(!allNames.includes("Not Yours Plumbing"), "another landlord's vendor is never a candidate");
  assert.ok(result.excludedCandidates.some((candidate) => candidate.name === "Outside City Plumbing"));
  assert.ok(
    result.excludedCandidates.some(
      (candidate) => candidate.name === "River Electrical" && (candidate.reasonCodes || []).includes("service_mismatch")
    )
  );
  assert.strictEqual(result.decision.actionType, "recommend_preset_vendor");
  assert.ok(!("includeDemoExternalCandidates" in result), "the snapshot no longer carries the demo switch");

  /* -------------- 4) An empty network says so ------------------------- */

  const empty = await generateVendorRecommendations(
    { request, property, unit, policy },
    { vendorRepository: makeRepository([]), registry: strictRegistry, loadPaidJobTotals: noHistory }
  );
  assert.strictEqual(empty.recommendations.length, 0, "no vendors means no recommendations -- never invented ones");
  assert.strictEqual(empty.diagnostics.outcomeCode, "no_candidates_discovered");
  assert.match(empty.diagnostics.recommendedNextAction || "", /vendor network/);

  /* -------------- 5) Landlord vocabulary routes ----------------------- */

  const pest = await generateVendorRecommendations(
    { request: { ...request, _id: "req-pest", category: "Pest", vendorTypeNeeded: "Pest" }, property, unit, policy },
    {
      vendorRepository: makeRepository([
        presetRow({ _id: "507f191e810c19729de860f1", name: "Bug Busters", specialties: ["Pest Control"] }),
        presetRow({ _id: "507f191e810c19729de860f2", name: "Lock Smiths", specialties: [], customSpecialties: ["locksmith"] }),
      ]),
      registry: strictRegistry,
      loadPaidJobTotals: noHistory,
    }
  );
  assert.strictEqual(pest.recommendations[0]?.name, "Bug Busters", 'a "Pest Control" vendor is recommended for a Pest job');
  assert.ok(pest.excludedCandidates.some((candidate) => candidate.name === "Lock Smiths"));

  /* -------------- 6) A vendor who already declined never comes back ---- */
  // A decline removes that vendor as an option for THIS request. Regeneration
  // rebuilds the ledger from scratch, so without the prior-outreach index it
  // handed them a Recommended slot again -- and approving that slot collides
  // with the unique index on { requestId, candidateKey, attempt }, which is how
  // a request deadlocked with an active candidate that could never answer.
  const declinedKey = result.recommendations[0].candidateKey;
  const afterDecline = await generateVendorRecommendations(
    {
      request,
      property,
      unit,
      policy,
      priorOutreach: [
        {
          candidateKey: declinedKey,
          status: "declined",
          attempt: 1,
          respondedAt: "2030-01-06T12:00:00.000Z",
          response: { declineReason: "Booked solid this week" },
        },
      ],
    },
    { vendorRepository: network, registry: strictRegistry, loadPaidJobTotals: noHistory }
  );
  const declinedEntry = afterDecline.candidateLedger.find((candidate) => candidate.candidateKey === declinedKey);
  assert.strictEqual(declinedEntry.state, "excluded", "the declined vendor is excluded on sight");
  assert.ok(declinedEntry.humanReadableReasons.some((line) => line.includes("Booked solid this week")));
  assert.ok(afterDecline.recommendations.every((candidate) => candidate.candidateKey !== declinedKey));
  assert.strictEqual(afterDecline.recommendations[0].name, "Second Regina Plumbing", "the next vendor moves up");
  assert.strictEqual(afterDecline.diagnostics.contactableCount, result.diagnostics.eligibleCount - 1);
  assert.strictEqual(afterDecline.diagnostics.eligibleCount, result.diagnostics.eligibleCount);

  // Every eligible vendor has now been tried. The decision used to say "no
  // eligible vendors passed the constraints" while the outcome tile said
  // "ready_to_route" -- both false, side by side.
  const everyoneTried = await generateVendorRecommendations(
    {
      request,
      property,
      unit,
      policy,
      priorOutreach: result.candidateLedger
        .filter((candidate) => candidate.state !== "excluded")
        .map((candidate) => ({ candidateKey: candidate.candidateKey, status: "declined", attempt: 1 })),
    },
    { vendorRepository: network, registry: strictRegistry, loadPaidJobTotals: noHistory }
  );
  assert.strictEqual(everyoneTried.recommendations.length, 0);
  assert.strictEqual(everyoneTried.diagnostics.outcomeCode, "all_vendors_contacted");
  assert.strictEqual(everyoneTried.decision.reasonCode, "all_vendors_contacted");
  assert.ok(!/passed the constraints/.test(everyoneTried.decision.managerSummary), everyoneTried.decision.managerSummary);
  assert.match(everyoneTried.diagnostics.recommendedNextAction, /Add a vendor, then search again/);

  // An outreach still in flight is not a closed round, so it must not exclude.
  const midRound = await generateVendorRecommendations(
    { request, property, unit, policy, priorOutreach: [{ candidateKey: declinedKey, status: "sent", attempt: 1 }] },
    { vendorRepository: network, registry: strictRegistry, loadPaidJobTotals: noHistory }
  );
  assert.strictEqual(midRound.recommendations[0].candidateKey, declinedKey);

  /* -------------- 7) An unresolvable service asks for a human --------- */

  const unresolved = await generateVendorRecommendations(
    {
      request: { ...request, _id: "req-2", category: "Other", vendorTypeNeeded: null, issueTitle: "Unknown issue", issueDescription: "Something feels off." },
      property,
      unit,
      policy,
    },
    { vendorRepository: network, registry: strictRegistry, loadPaidJobTotals: noHistory }
  );
  assert.strictEqual(unresolved.decision.actionType, "manual_vendor_assignment_required");
  assert.strictEqual(unresolved.diagnostics.outcomeCode, "vendor_service_unresolved");

  /* -------------- 8) Estimates come from paid jobs, per trade --------- */
  // A vendor with no paid history has NO estimate -- not the old invented
  // hourlyRate..hourlyRate+75. With history, it is the average for THIS trade.
  const firstVendor = result.recommendations[0];
  assert.strictEqual(firstVendor.priceEstimate, null, "no paid jobs, no estimate");

  const TRUSTED = "507f191e810c19729de860eb";
  const withHistory = await generateVendorRecommendations(
    { request, property, unit, policy },
    {
      vendorRepository: network,
      registry: strictRegistry,
      loadPaidJobTotals: history([[TRUSTED, { Plumbing: { total: 500, count: 2 }, Electrical: { total: 900, count: 1 } }]]),
    }
  );
  const trusted = withHistory.candidateLedger.find((candidate) => candidate.vendorId === TRUSTED);
  assert.strictEqual(trusted.priceEstimate.amountLow, 250, "average of $200 and $300");
  assert.strictEqual(trusted.priceEstimate.amountHigh, 250);
  assert.strictEqual(trusted.priceEstimate.basis, "paid_job_average");
  assert.strictEqual(trusted.priceEstimate.sampleSize, 2);
  const second = withHistory.candidateLedger.find((candidate) => candidate.name === "Second Regina Plumbing");
  assert.strictEqual(second.priceEstimate, null, "history is per vendor");

  // The same vendor on an electrical job: only electrical history counts.
  const electricalNetwork = makeRepository([
    presetRow({ _id: TRUSTED, name: "Trusted Preset Plumbing", specialties: ["Plumbing", "Electrical"] }),
  ]);
  const electrical = await generateVendorRecommendations(
    { request: { ...request, _id: "req-e", category: "Electrical", vendorTypeNeeded: "Electrical" }, property, unit, policy },
    {
      vendorRepository: electricalNetwork,
      registry: strictRegistry,
      loadPaidJobTotals: history([[TRUSTED, { Plumbing: { total: 500, count: 2 } }]]),
    }
  );
  assert.strictEqual(electrical.recommendations[0].priceEstimate, null, "plumbing history never prices an electrical job");

  // An unknown cost is not over quota: the top scorer stays the pick even when
  // a lower-ranked vendor has a price that fits.
  const pick = await generateVendorRecommendations(
    { request, property, unit, policy },
    {
      vendorRepository: network,
      registry: strictRegistry,
      loadPaidJobTotals: history([["507f191e810c19729de860ec", { Plumbing: { total: 200, count: 1 } }]]),
    }
  );
  assert.strictEqual(pick.recommendations[0].name, "Trusted Preset Plumbing");
  assert.strictEqual(pick.decision.actionType, "recommend_preset_vendor");
  const affordable = await generateVendorRecommendations(
    { request, property, unit, policy },
    { vendorRepository: network, registry: strictRegistry,
      loadPaidJobTotals: history([[TRUSTED, { Plumbing: { total: 800, count: 1 } }],
        ["507f191e810c19729de860ec", { Plumbing: { total: 100, count: 1 } }]]) }
  );
  assert.strictEqual(affordable.recommendations[0].name, "Second Regina Plumbing", "the affordable policy pick leads the displayed list");
  assert.strictEqual(affordable.decision.candidateKey, affordable.recommendations[0].candidateKey, "decision and contacted candidate cannot diverge");

  // A history lookup failure costs the estimate, never the recommendations.
  const failing = await generateVendorRecommendations(
    { request, property, unit, policy },
    {
      vendorRepository: network,
      registry: strictRegistry,
      loadPaidJobTotals: async () => {
        throw new Error("db down");
      },
    }
  );
  assert.ok(failing.recommendations.length > 0);

  /* -------------- 9) Availability comes from hours of operation ------- */
  // These used to be [] for every network vendor.
  const { normalizeHours } = require("../../../services/vendor/vendorHours");
  const hoursNetwork = makeRepository([
    presetRow({
      _id: "507f191e810c19729de860f3",
      name: "Saturday Plumbing",
      specialties: ["Plumbing"],
      operatingHours: normalizeHours({ preset: "custom", weekly: [{ day: 6, open: "10:00", close: "14:00" }] }),
      businessHours: "Sat 10:00–14:00",
    }),
  ]);
  const withSlots = await generateVendorRecommendations(
    { request: { ...request, urgency: "medium", ai: { summary: "Leak", severity: 3 } }, property, unit, policy },
    {
      vendorRepository: hoursNetwork,
      registry: strictRegistry,
      loadPaidJobTotals: noHistory,
      now: new Date("2026-07-28T15:00:00.000Z"), // Tue 09:00 Regina
    }
  );
  const saturdayOnly = withSlots.recommendations[0];
  assert.ok(saturdayOnly.availabilitySlots.length > 0, "slots are filled from the vendor's hours");
  saturdayOnly.availabilitySlots.forEach((slot) => {
    const localDay = new Date(new Date(slot.start).getTime() - 6 * 3600 * 1000).getUTCDay();
    assert.strictEqual(localDay, 6, `a Saturday-only vendor offered ${slot.label}`);
    assert.strictEqual(typeof slot.start, "string", "slots are stored as ISO strings");
  });
  assert.strictEqual(saturdayOnly.hoursLabel, "Sat 10:00–14:00");
  // A row with no hours at all still gets slots (the default weekday window)
  // and simply has no hours line.
  assert.ok(result.recommendations[0].availabilitySlots.length > 0, "no hours set still yields slots");
  assert.strictEqual(result.recommendations[0].hoursLabel, null);

  console.log("vendorRecommendation.service tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
