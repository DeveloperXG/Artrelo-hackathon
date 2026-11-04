// What a landlord's vendor routing can actually do right now: how many vendors
// a request can reach, and how many the policy lets Artrelo contact.
//
// The two numbers disagree more often than not on a small network. "Max vendors
// contacted per request" set to 3 with 2 vendors means 2, and the routing panel
// used to say "vendor 2 of 3" with nobody left to be the third.

const Vendor = require("../../models/Vendor");
const LandlordPolicy = require("../../models/LandlordPolicy");
const { routableVendorFilter } = require("./vendorRecommendation.service");

const MAX_VENDORS_DEFAULT = LandlordPolicy.schema.path("maxOutreachAttempts").defaultValue;

/**
 * The policy's vendor cap as a number. A landlord who never opened the Policy
 * page has no document, and a lean read skips schema defaults, so both fall
 * back to the schema's own default rather than a second hard-coded copy.
 * `Number(x) || 3` is the trap this replaces: it turns a deliberate 0 into 3.
 */
function resolveMaxVendors(policy) {
  const raw = policy?.maxOutreachAttempts;
  if (raw === null || raw === undefined || raw === "") return MAX_VENDORS_DEFAULT;
  const value = Number(raw);
  return Number.isFinite(value) ? value : MAX_VENDORS_DEFAULT;
}

async function getRoutingSetup(landlordId) {
  const [activeVendorCount, policy] = await Promise.all([
    Vendor.countDocuments(routableVendorFilter(landlordId)),
    LandlordPolicy.findOne({ landlordId }).select("maxOutreachAttempts").lean(),
  ]);
  const maxOutreachAttempts = resolveMaxVendors(policy);
  // Order is the order a landlord fixes them in: there is no point choosing a
  // cap before there is anyone to contact.
  const missing = [];
  if (activeVendorCount < 1) missing.push("vendors");
  if (maxOutreachAttempts < 1) missing.push("max_vendors");
  return {
    activeVendorCount,
    maxOutreachAttempts,
    // The most vendors one request can reach. Per request it can be lower
    // still: only vendors who cover the trade are eligible.
    effectiveCap: Math.min(activeVendorCount, maxOutreachAttempts),
    ready: missing.length === 0,
    missing,
  };
}

const ROUTING_SETUP_INCOMPLETE = "routing_setup_incomplete";

function routingSetupMessage(missing) {
  const needsVendors = missing.includes("vendors");
  const needsCap = missing.includes("max_vendors");
  if (needsVendors && needsCap) {
    return 'Add a vendor and set "Max vendors contacted per request" to at least 1 before Artrelo can contact vendors.';
  }
  if (needsVendors) return "Add at least one vendor before Artrelo can contact vendors.";
  return 'Set "Max vendors contacted per request" to at least 1 on the Policy page before Artrelo can contact vendors.';
}

/**
 * Refuses (409 routing_setup_incomplete) anything that would search for or
 * contact a vendor while the landlord has no vendors or a vendor cap of 0.
 * The setup rides on the error so the client can render the checklist from
 * the same answer the server acted on.
 */
async function assertRoutingSetupReady(landlordId) {
  const setup = await getRoutingSetup(landlordId);
  if (setup.ready) return setup;
  const err = new Error(routingSetupMessage(setup.missing));
  err.statusCode = 409;
  err.code = ROUTING_SETUP_INCOMPLETE;
  err.setup = setup;
  throw err;
}

module.exports = {
  ROUTING_SETUP_INCOMPLETE,
  assertRoutingSetupReady,
  getRoutingSetup,
  resolveMaxVendors,
};
