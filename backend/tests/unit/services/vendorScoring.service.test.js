const assert = require("assert");
const mongoose = require("mongoose");
const {
  scoreVendorCandidates,
} = require("../../../services/vendor/vendorScoring.service");

const request = {
  category: "Plumbing",
  urgency: "high",
  estimatedCost: 150,
};

const policy = {
  defaultQuota: 300,
};

const preferredVendorId = new mongoose.Types.ObjectId().toString();
const standardVendorId = new mongoose.Types.ObjectId().toString();

const candidates = [
  {
    _id: preferredVendorId,
    name: "Preferred Plumbing",
    specialtyScore: 1,
    preferred: true,
    source: "preset",
    emergencyAvailable: true,
    averageCost: 180,
    rating: 4.8,
    reliabilityScore: 95,
  },
  {
    _id: standardVendorId,
    name: "Standard Plumbing",
    specialtyScore: 0.85,
    preferred: false,
    source: "preset",
    emergencyAvailable: false,
    averageCost: 180,
    rating: 4.1,
    reliabilityScore: 70,
  },
];

const firstRun = scoreVendorCandidates({
  request,
  vendors: candidates,
  policy,
  requestContext: {
    sameCityVendorIds: [preferredVendorId, standardVendorId],
    serviceAreaVendorIds: [],
  },
});

const secondRun = scoreVendorCandidates({
  request,
  vendors: candidates,
  policy,
  requestContext: {
    sameCityVendorIds: [preferredVendorId, standardVendorId],
    serviceAreaVendorIds: [],
  },
});

assert.deepStrictEqual(firstRun, secondRun);
assert.strictEqual(firstRun[0].vendorId, preferredVendorId);
assert.ok(firstRun[0].score > firstRun[1].score);
assert.ok(firstRun[0].scoreBreakdown.availability.weight >= 0.25);
assert.ok(firstRun[0].scoreBreakdown.specialtyMatch.contribution > 0);

console.log("vendor scoring tests passed");
