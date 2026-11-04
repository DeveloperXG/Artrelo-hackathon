const mongoose = require("mongoose");
const Property = require("../models/Property");
const Unit = require("../models/Unit");
const Tenant = require("../models/Tenant");
const Vendor = require("../models/Vendor");
const Landlord = require("../models/Landlord");
const LandlordPolicy = require("../models/LandlordPolicy");
const policyWriter = require("../services/policy/policyWrite.service");
const InviteCode = require("../models/Code");
const MaintenanceRequest = require("../models/MaintenanceRequest");
const ApprovalRequest = require("../models/ApprovalRequest");
const Appointment = require("../models/Appointment");
const LedgerEntry = require("../models/LedgerEntry");
const LandlordLedger = require("../models/LandlordLedger");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { getBalance } = require("../services/ledger/ledger.service");
const { landlordPaymentMode } = require("../services/ledger/paymentMode");
const { countDirectPaymentsDue } = require("../services/ledger/directPayment.service");
const { getRoutingSetup } = require("../services/vendor/routingSetup.service");
const { expireOrphanedQuoteApprovals } = require("../services/vendor/vendorQuoteDismissal.service");
const {
  MAX_BATCH_SIZE,
  validateUnitBatch,
  comparisonKey,
} = require("../services/property/unitBatch.service");
const {
  validatePortfolioBatch,
  checkPortfolioSize,
} = require("../services/property/portfolioBatch.service");
const { fromCents } = require("../services/ledger/money");
const {
  pickVendorInput,
  validateVendorInput,
  editableSnapshot,
  contactKey,
} = require("../services/vendor/vendorInput.service");

// Invite codes are minted only by the shared service. This file used to carry
// its own six-hex-character generator, which is how the codes landlords
// actually issue stayed weak after the other copy was hardened.
const { createInviteCode } = require("../services/inviteCode/inviteCode.service");
const {
  checkDeletion,
  serializeCheck,
  retireTarget,
  sendMoveOutNotices,
  completeMoveOut,
} = require("../services/portfolio/deletionGuard.service");
const { updateProperty, updateUnit, getEditImpact } = require("../services/portfolio/portfolioEdit.service");
const { listRoutingDecisions } = require("../services/request/decisionQueue.service");
const { monthlyTrend, dailyTrend } = require("../services/reports/trendBuckets");

// Archived properties and units are retired: hidden from every list, picker
// and duplicate-name check, but still readable by id for history and money.
// `{ archivedAt: null }` also matches rows written before the field existed.
const LIVE = { archivedAt: null };

// ---- PROPERTIES ----
exports.listProperties = async (req, res) => {
  try {
    // Default: live properties with their live units. ?archived=1 lists only the
    // retired ones (the Archived section); ?archived=all lists everything with
    // every unit, for History, which must resolve retired units too.
    const mode = req.query?.archived;
    const filter = { landlordId: req.user.id };
    if (mode === "1") filter.archivedAt = { $ne: null };
    else if (mode !== "all") filter.archivedAt = null;
    const properties = await Property.find(filter)
      .populate(mode === "1" || mode === "all" ? "units" : { path: "units", match: LIVE })
      .lean();
    return res.json({ success: true, data: properties });
  } catch (err) {
    console.error("[listProperties]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.createProperty = async (req, res) => {
  try {
    const { name, address, description, amenities = [] } = req.body;
    if (!name || !address) {
      return res.status(400).json({ success: false, message: "name and address are required" });
    }
    const property = await Property.create({
      landlordId: req.user.id,
      name,
      address,
      description,
      amenities,
    });

    await Landlord.findByIdAndUpdate(
      req.user.id,
      { $addToSet: { properties: property._id } }
    );

    return res.status(201).json({ success: true, data: property });
  } catch (err) {
    console.error("[createProperty]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Portfolio import: properties and their units in one pass.
//
// The alternative a landlord onboarding twelve buildings faces today is
// twelve "add property" forms followed by 438 "add unit" forms. This is the
// same funnel as bulk units one level up — parse, review, validate, confirm —
// and it reuses the unit validator rather than restating it, so a unit in a
// portfolio import obeys exactly the rules a unit in a single-property import
// obeys.
const preparePortfolioBatch = async (req) => {
  const proposed = req.body?.properties;
  const sizeError = checkPortfolioSize(proposed);
  if (sizeError) return { error: { status: 400, message: sizeError } };

  const existing = await Property.find({ landlordId: req.user.id, ...LIVE }).select("name").lean();
  const result = validatePortfolioBatch(
    proposed,
    existing.map((property) => property.name)
  );
  return { result };
};

// Dry run. Answers "12 properties, 438 units, 7 duplicates, 3 invalid" against
// live data and writes nothing.
exports.validatePortfolio = async (req, res) => {
  try {
    const { error, result } = await preparePortfolioBatch(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[validatePortfolio]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.importPortfolio = async (req, res) => {
  let createdProperties = [];
  let createdUnits = [];
  try {
    const { error, result } = await preparePortfolioBatch(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    if (!result.valid) {
      return res.status(422).json({
        success: false,
        message: `${result.summary.invalidProperties} of ${result.summary.properties} properties failed validation`,
        data: result,
      });
    }

    // Two inserts for the whole import, not two per property.
    createdProperties = await Property.insertMany(
      result.properties.map((property) => ({
        landlordId: req.user.id,
        name: property.name,
        address: property.address,
      })),
      { ordered: true }
    );

    const unitDocs = [];
    result.properties.forEach((property, at) => {
      for (const row of property.units.rows) {
        unitDocs.push({ propertyId: createdProperties[at]._id, unitNumber: row.name });
      }
    });
    createdUnits = await Unit.insertMany(unitDocs, { ordered: true });

    // Link units onto their property, one update per property. A property with
    // no units cannot happen here — NO_UNITS is a validation error.
    let cursor = 0;
    const links = result.properties.map((property, at) => {
      const ids = createdUnits.slice(cursor, cursor + property.units.rows.length).map((u) => u._id);
      cursor += property.units.rows.length;
      return {
        updateOne: {
          filter: { _id: createdProperties[at]._id },
          update: { $addToSet: { units: { $each: ids } } },
        },
      };
    });
    if (links.length > 0) await Property.bulkWrite(links);

    await Landlord.findByIdAndUpdate(req.user.id, {
      $addToSet: { properties: { $each: createdProperties.map((property) => property._id) } },
    });

    return res.status(201).json({
      success: true,
      message: `Created ${createdProperties.length} propert${
        createdProperties.length === 1 ? "y" : "ies"
      } and ${createdUnits.length} unit${createdUnits.length === 1 ? "" : "s"}`,
      data: {
        properties: createdProperties,
        summary: {
          ...result.summary,
          propertiesCreated: createdProperties.length,
          unitsCreated: createdUnits.length,
        },
      },
    });
  } catch (err) {
    console.error("[importPortfolio]", err);
    // Compensating delete. A portfolio half-imported is worse than one not
    // imported: the landlord cannot tell which buildings landed without
    // walking the list, and re-running collides with whatever did.
    try {
      if (createdUnits.length > 0) {
        await Unit.deleteMany({ _id: { $in: createdUnits.map((unit) => unit._id) } });
      }
      if (createdProperties.length > 0) {
        const ids = createdProperties.map((property) => property._id);
        await Property.deleteMany({ _id: { $in: ids } });
        await Landlord.findByIdAndUpdate(req.user.id, { $pull: { properties: { $in: ids } } });
      }
    } catch (rollbackError) {
      console.error("[importPortfolio] rollback failed", rollbackError);
    }
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Delete and deletion-check share one implementation per kind. The rules live
// in services/portfolio/deletionGuard.service.js; these only translate them.
const NOT_FOUND = { property: "Property not found", unit: "Unit not found" };

const deletionCheckHandler = (kind) => async (req, res) => {
  try {
    const check = await checkDeletion({ landlordId: req.user.id, kind, id: req.params.id });
    if (!check) return res.status(404).json({ success: false, message: NOT_FOUND[kind] });
    return res.json({ success: true, data: serializeCheck(check) });
  } catch (err) {
    console.error(`[${kind}DeletionCheck]`, err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const deleteHandler = (kind) => async (req, res) => {
  try {
    // Re-checked here, never trusted from the dialog: a stale tab or a raw
    // DELETE must hit the same wall.
    const check = await checkDeletion({ landlordId: req.user.id, kind, id: req.params.id });
    if (!check || check.target[kind]?.archivedAt) {
      return res.status(404).json({ success: false, message: NOT_FOUND[kind] });
    }
    if (check.blocked) {
      return res.status(409).json({
        success: false,
        code: "deletion_blocked",
        message: check.blockers.tenants.length
          ? `${check.target.label} still has tenants. Ask them to move out first.`
          : `${check.target.label} still has open requests. Finish or cancel them first.`,
        data: serializeCheck(check),
      });
    }

    const { action } = await retireTarget(check);
    return res.json({ success: true, data: { _id: req.params.id, action } });
  } catch (err) {
    console.error(`[delete ${kind}]`, err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ---- EDITING ----
// Rules (whitelist, collisions, archived = read-only, the address-change
// vendor notice) live in services/portfolio/portfolioEdit.service.js.
const sendResult = (res, result, key) => {
  if (result.error) {
    const { status, ...rest } = result.error;
    return res.status(status).json({ success: false, ...rest });
  }
  return res.json({ success: true, data: result[key], changed: result.changed, notifiedVendors: result.notifiedVendors });
};

exports.updateProperty = async (req, res) => {
  try {
    const landlord = await Landlord.findById(req.user.id).select("firstName lastName companyName").lean();
    const managerLabel =
      landlord?.companyName ||
      [landlord?.firstName, landlord?.lastName].filter(Boolean).join(" ") ||
      "Your property manager";
    const result = await updateProperty({
      landlordId: req.user.id,
      id: req.params.id,
      input: req.body || {},
      managerLabel,
    });
    return sendResult(res, result, "property");
  } catch (err) {
    console.error("[updateProperty]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.propertyEditImpact = async (req, res) => {
  try {
    const impact = await getEditImpact({ landlordId: req.user.id, id: req.params.id });
    if (!impact) return res.status(404).json({ success: false, message: NOT_FOUND.property });
    return res.json({ success: true, data: impact });
  } catch (err) {
    console.error("[propertyEditImpact]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.updateUnit = async (req, res) => {
  try {
    const result = await updateUnit({ landlordId: req.user.id, id: req.params.id, input: req.body || {} });
    return sendResult(res, result, "unit");
  } catch (err) {
    console.error("[updateUnit]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.propertyDeletionCheck = deletionCheckHandler("property");
exports.unitDeletionCheck = deletionCheckHandler("unit");
exports.deleteProperty = deleteHandler("property");
exports.deleteUnit = deleteHandler("unit");

// ---- MOVE-OUT ----
// Asks every tenant blocking a property/unit deletion to move out.
exports.sendMoveOutNotice = async (req, res) => {
  try {
    const { kind, id } = req.body || {};
    if (!["property", "unit"].includes(kind)) {
      return res.status(400).json({ success: false, message: "kind must be property or unit" });
    }
    const result = await sendMoveOutNotices({
      landlordId: req.user.id,
      kind,
      id,
      actorUserId: req.user.id,
    });
    if (!result) return res.status(404).json({ success: false, message: NOT_FOUND[kind] });

    // Re-read so the dialog renders the requested state it just caused.
    const check = await checkDeletion({ landlordId: req.user.id, kind, id });
    return res.json({
      success: true,
      data: { notified: result.notified, check: check ? serializeCheck(check) : null },
    });
  } catch (err) {
    console.error("[sendMoveOutNotice]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// The landlord override: moves a tenant out directly, notice or not -- for
// someone who left without confirming.
exports.moveOutTenant = async (req, res) => {
  try {
    const result = await completeMoveOut({
      tenantId: req.params.id,
      landlordId: req.user.id,
      by: "landlord",
    });
    if (result.error) {
      const { status, ...rest } = result.error;
      return res.status(status).json({ success: false, ...rest });
    }
    return res.json({ success: true, data: result.tenant });
  } catch (err) {
    console.error("[moveOutTenant]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ---- UNITS ----
exports.listUnits = async (req, res) => {
  try {
    const { propertyId } = req.query;
    const properties = await Property.find({ landlordId: req.user.id, ...LIVE }).select("_id");
    const propertyIds = properties.map((p) => p._id);
    const filter = { propertyId: { $in: propertyIds }, ...LIVE };
    if (propertyId) filter.propertyId = propertyId;
    const units = await Unit.find(filter).lean();
    return res.json({ success: true, data: units });
  } catch (err) {
    console.error("[listUnits]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.createUnit = async (req, res) => {
  try {
    const { propertyId, unitNumber } = req.body;
    if (!propertyId || !unitNumber) {
      return res.status(400).json({ success: false, message: "propertyId and unitNumber are required" });
    }
    const property = await Property.findOne({ _id: propertyId, landlordId: req.user.id, ...LIVE });
    if (!property) return res.status(404).json({ success: false, message: "Property not found" });

    // One unit is a batch of one. Same normalization, same collision check, so
    // the quick path cannot create the duplicate the bulk path would refuse.
    const existing = await Unit.find({ propertyId, ...LIVE }).select("unitNumber").lean();
    const { rows } = validateUnitBatch([unitNumber], existing.map((row) => row.unitNumber));
    const [row] = rows;
    if (!row.valid) {
      return res.status(422).json({ success: false, message: row.errors[0].message });
    }

    const unit = await Unit.create({ propertyId, unitNumber: row.name });
    property.units.push(unit._id);
    await property.save();
    return res.status(201).json({ success: true, data: unit });
  } catch (err) {
    console.error("[createUnit]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Shared front door for every bulk unit path: the pattern generator, a pasted
// list, a CSV upload. They all arrive here as a plain array of identifiers, are
// checked against the same rules, and either all land or none do.
//
// `Property.findOne({ _id, landlordId })` is the authorization check: a landlord
// who does not own the property gets the same 404 as one that does not exist,
// so the endpoint cannot be used to probe for other landlords' property ids.
const loadOwnedProperty = (req) =>
  Property.findOne({ _id: req.params.propertyId, landlordId: req.user.id, ...LIVE });

// Both bulk handlers need the same three things: the property, the identifiers
// it already holds, and a validated view of the proposal. One query for the
// property, one for its units — never one per proposed unit.
const prepareUnitBatch = async (req) => {
  const property = await loadOwnedProperty(req);
  if (!property) return { error: { status: 404, message: "Property not found" } };

  const proposed = Array.isArray(req.body?.units) ? req.body.units : null;
  if (!proposed || proposed.length === 0) {
    return { error: { status: 400, message: "units must be a non-empty array" } };
  }
  if (proposed.length > MAX_BATCH_SIZE) {
    return {
      error: {
        status: 400,
        message: `A batch may contain at most ${MAX_BATCH_SIZE} units (received ${proposed.length})`,
      },
    };
  }

  const existing = await Unit.find({ propertyId: property._id, ...LIVE }).select("unitNumber").lean();
  const result = validateUnitBatch(
    proposed,
    existing.map((unit) => unit.unitNumber)
  );
  return { property, result };
};

// Dry run. Validates the batch against live data and writes nothing, so the
// review table can show real collisions with what is already in the property
// before the landlord commits to anything.
exports.validateUnitsBulk = async (req, res) => {
  try {
    const { error, result } = await prepareUnitBatch(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[validateUnitsBulk]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.createUnitsBulk = async (req, res) => {
  try {
    const { error, property, result } = await prepareUnitBatch(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    // All-or-nothing. A half-applied import leaves the landlord reconciling a
    // list by hand, which is worse than being told to fix four rows and retry.
    if (!result.valid) {
      return res.status(422).json({
        success: false,
        message: `${result.summary.invalid} of ${result.summary.total} units failed validation`,
        data: result,
      });
    }

    const created = await Unit.insertMany(
      result.rows.map((row) => ({ propertyId: property._id, unitNumber: row.name })),
      { ordered: true }
    );
    const createdIds = created.map((unit) => unit._id);

    try {
      // The collision check above and this insert are not one atomic operation,
      // and (propertyId, unitNumber) is not a unique index — see models/Unit.js
      // for why. So verify afterwards: if any identifier this batch wrote now
      // appears more than once, a concurrent request won the race and the
      // duplicate is ours to undo.
      const names = result.rows.map((row) => row.name);
      const nowInProperty = await Unit.find({ propertyId: property._id, unitNumber: { $in: names }, ...LIVE })
        .select("unitNumber")
        .lean();
      const counts = new Map();
      for (const unit of nowInProperty) {
        const key = comparisonKey(unit.unitNumber);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const raced = names.filter((name) => (counts.get(comparisonKey(name)) || 0) > 1);
      if (raced.length > 0) {
        throw Object.assign(new Error("concurrent-duplicate"), { raced });
      }

      await Property.updateOne({ _id: property._id }, { $addToSet: { units: { $each: createdIds } } });
    } catch (err) {
      // Compensating delete. Whatever went wrong after the insert, the batch
      // must not survive half-committed.
      await Unit.deleteMany({ _id: { $in: createdIds } });
      if (err.raced) {
        return res.status(409).json({
          success: false,
          message: "Another import created some of these units first. Nothing was created — review and retry.",
          data: { conflicts: err.raced },
        });
      }
      throw err;
    }

    return res.status(201).json({
      success: true,
      message: `Created ${created.length} unit${created.length === 1 ? "" : "s"}`,
      data: { created, summary: { ...result.summary, created: created.length } },
    });
  } catch (err) {
    console.error("[createUnitsBulk]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};


// ---- INVITE CODES ----
exports.generateInviteCode = async (req, res) => {
  try {
    const { propertyId, unitId, expiresDays = 7 } = req.body;

    // Both are required. A code without a unit let a tenant sign up attached
    // to no unit at all: their requests then carried no unit and no property,
    // and could not be routed, capped per unit, or found under the property.
    // Field-level messages, so the dialog can put each one on its field.
    const fields = {};
    if (!propertyId || !mongoose.isValidObjectId(propertyId)) fields.propertyId = "Select a property.";
    if (!unitId || !mongoose.isValidObjectId(unitId)) fields.unitId = "Select a unit.";
    if (Object.keys(fields).length) {
      return res.status(400).json({ success: false, message: "Choose a property and a unit.", fields });
    }

    // A retired property or unit takes no new tenants.
    const property = await Property.findOne({ _id: propertyId, landlordId: req.user.id, ...LIVE });
    if (!property) return res.status(404).json({ success: false, message: "Property not found" });

    const unit = await Unit.findOne({ _id: unitId, propertyId, ...LIVE });
    if (!unit) return res.status(404).json({ success: false, message: "Unit not found" });

    const expiresAt = new Date(Date.now() + expiresDays * 24 * 3600 * 1000);
    const inviteCode = await createInviteCode({
      landlordId: req.user.id,
      propertyId,
      unitId,
      expiresAt,
    });
    return res.status(201).json({ success: true, data: inviteCode });
  } catch (err) {
    console.error("[generateInviteCode]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.listInviteCodes = async (req, res) => {
  try {
    // Expired codes are useless and the TTL sweep only removes them
    // eventually (Mongo's TTL monitor runs about once a minute, and lags under
    // load); don't show a landlord a code that will be refused.
    const codes = await InviteCode.find({ landlordId: req.user.id, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .populate("propertyId", "name")
      .populate("unitId", "unitNumber")
      .lean();
    return res.json({ success: true, data: codes });
  } catch (err) {
    console.error("[listInviteCodes]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.deleteInviteCode = async (req, res) => {
  try {
    // An id that is not even an ObjectId is just "not found" -- not a 500.
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Invite code not found" });
    }
    // Scoped to the landlord: another landlord's code id is a 404, never a
    // delete. Atomic with redemption, which also claims the code with
    // findOneAndDelete -- whichever runs first wins, and a tenant mid-signup
    // whose code was revoked gets "code no longer valid".
    const code = await InviteCode.findOneAndDelete({ _id: req.params.id, landlordId: req.user.id });
    if (!code) return res.status(404).json({ success: false, message: "Invite code not found" });
    return res.json({ success: true, data: { _id: code._id } });
  } catch (err) {
    console.error("[deleteInviteCode]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ---- TENANTS ----
exports.listTenants = async (req, res) => {
  try {
    const tenants = await Tenant.find({ landlord: req.user.id })
      
      .populate("unit", "unitNumber propertyId")
      .lean();
    return res.json({ success: true, data: tenants });
  } catch (err) {
    console.error("[listTenants]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ---- VENDORS ----
exports.listVendors = async (req, res) => {
  try {
    const vendors = await Vendor.find({ landlordId: req.user.id }).lean();
    return res.json({ success: true, data: vendors });
  } catch (err) {
    console.error("[listVendors]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const vendorValidationFailed = (res, fields) =>
  res.status(400).json({ success: false, message: "Check the highlighted fields.", fields });

exports.createVendor = async (req, res) => {
  try {
    const { value, fields } = validateVendorInput(pickVendorInput(req.body));
    if (!value) return vendorValidationFailed(res, fields);

    // System-owned fields are set here, never taken from the body: see the
    // header of vendorInput.service for what a client could forge before.
    const { trusted, ...doc } = value;
    const vendor = await Vendor.create({
      ...doc,
      landlordId: req.user.id,
      source: "preset",
      providerName: "manual",
      verificationStatus: trusted ? "trusted" : "unverified",
    });
    return res.status(201).json({ success: true, data: vendor });
  } catch (err) {
    console.error("[createVendor]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.updateVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findOne({ _id: req.params.id, landlordId: req.user.id });
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found" });

    // Validate the vendor as it WILL be, not just the fields sent: an edit that
    // only renames a pre-rule vendor must still supply the email and hours it
    // never had.
    const merged = { ...editableSnapshot(vendor), ...pickVendorInput(req.body) };
    const { value, fields } = validateVendorInput(merged);
    if (!value) return vendorValidationFailed(res, fields);

    // identityId is only a backfill-time pointer -- outreach resolves the
    // contractor afresh from the current phone/email on every send, and a job
    // already in flight pays the identity captured on its outreach row. So a
    // changed contact cannot misroute money; clearing the pointer just keeps it
    // from naming someone the vendor no longer is.
    if (vendor.identityId && contactKey(vendor) !== contactKey(value)) {
      vendor.identityId = null;
    }

    const { trusted, ...doc } = value;
    vendor.set(doc);
    // Only the trusted/unverified pair is the landlord's to flip. A vendor the
    // system blocked stays blocked whatever the form says.
    if (vendor.verificationStatus !== "blocked") {
      vendor.verificationStatus = trusted ? "trusted" : "unverified";
    }
    await vendor.save();
    return res.json({ success: true, data: vendor });
  } catch (err) {
    console.error("[updateVendor]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.deleteVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findOneAndDelete({ _id: req.params.id, landlordId: req.user.id });
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found" });
    return res.json({ success: true, data: { _id: vendor._id } });
  } catch (err) {
    console.error("[deleteVendor]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ---- LANDLORD POLICY ----
exports.getPolicy = async (req, res) => {
  try {
    let policy = await LandlordPolicy.findOne({ landlordId: req.user.id }).lean();
    if (!policy) {
      policy = await LandlordPolicy.create({ landlordId: req.user.id });
      policy = policy.toObject();
    }
    return res.json({ success: true, data: policyWriter.presentPolicy(policy) });
  } catch (err) {
    console.error("[getPolicy]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Numbers and numeric strings only. Number(null), Number("") and Number(true)
// are 0, 0 and 1 -- a policy value nobody typed.
const isNumberLike = (raw) => typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "");

const QUOTA_MAP_FIELDS = ["categoryQuotas", "propertyQuotas", "unitQuotas"];

// A category/property/unit quota map: { key: amount > 0 }. The schema types
// these as Map<Number> with no bounds, so a 0 or negative override -- which
// would put every matching job over quota -- passed straight through.
function validQuotaMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((amount) => isNumberLike(amount) && Number(amount) > 0);
}

// What to tell the landlord when Mongoose's update validators refuse a field.
const POLICY_FIELD_MESSAGES = {
  digestFrequency: "Choose instant, hourly or daily.",
  emergencyNotificationChannels: "Choose from email, SMS and push.",
  lowFundsThreshold: "Enter an amount of $0 or more.",
};
const policyFieldMessage = (field) => POLICY_FIELD_MESSAGES[field] || "Check this setting.";

// How many vendors a request can reach versus how many the policy allows.
// Separate from GET /policy so the vendor count stays fresh after a vendor is
// added elsewhere without re-reading (and re-seeding) the policy document.
exports.getRoutingSetup = async (req, res) => {
  try {
    return res.json({ success: true, data: await getRoutingSetup(req.user.id) });
  } catch (err) {
    console.error("[getRoutingSetup]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Fields governing unpassed routing/contact checkpoints. Advance opt-in is
// read at each replacement candidate; digest/channels/funds thresholds never
// regenerate an existing recommendation plan.
const ROUTING_POLICY_FIELDS = [
  "defaultQuota",
  "categoryQuotas",
  "propertyQuotas",
  "unitQuotas",
  "requireApprovalOverQuota",
  "requireApprovalForFirstTimeVendor",
  "maxOutreachAttempts",
  "allowAutopilotForLowSeverity",
  "allowAutopilotForMediumSeverity",
];

// Order-insensitive, so a quota map re-saved with its keys shuffled is not a
// change.
function stableJson(value) {
  if (value instanceof Map) value = Object.fromEntries(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function routingPolicyChanged(before, after, update) {
  const saved = typeof after?.toObject === "function" ? after.toObject({ flattenMaps: true }) : after || {};
  return ROUTING_POLICY_FIELDS.some(
    (field) =>
      Object.prototype.hasOwnProperty.call(update, field) && stableJson(before?.[field]) !== stableJson(saved[field])
  );
}

exports.upsertPolicy = async (req, res) => {
  try {
    if (!Object.hasOwn(req.body || {}, "expectedPolicyRevision")) {
      return res.status(428).json({ success: false, code: "policy_revision_required", message: "Reload Policy before saving these settings.", retryAfterSeconds: null, currentPolicyRevision: null, field: "expectedPolicyRevision" });
    }
    const allowedUpdates = [
      "defaultQuota",
      "categoryQuotas",
      "propertyQuotas",
      "unitQuotas",
      "requireApprovalForExternalSearch",
      "requireApprovalOverQuota",
      "requireApprovalForFirstTimeVendor",
      "allowQuoteClarification",
      "allowAutopilotForLowSeverity",
      "allowAutopilotForMediumSeverity",
      "digestFrequency",
      "emergencyNotificationChannels",
      "lowFundsThreshold",
      "autoAdvanceOnVendorDecline",
      "maxOutreachAttempts",
    ];

    const update = {};
    allowedUpdates.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
    });
    if (Object.hasOwn(update, "allowQuoteClarification") && typeof update.allowQuoteClarification !== "boolean") {
      return res.status(400).json({ success: false, field: "allowQuoteClarification", message: "Choose whether routine quote follow-up is allowed." });
    }

    // A quota is a positive dollar amount. Clearing it back to "not set" is
    // allowed (null); zero or garbage is not — `|| null` downstream would quietly
    // turn a typed 0 into "no quota".
    if (Object.prototype.hasOwnProperty.call(update, "defaultQuota")) {
      const raw = update.defaultQuota;
      if (raw === null || raw === "") {
        update.defaultQuota = null;
      } else {
        const quota = Number(raw);
        if (!Number.isFinite(quota) || quota <= 0) {
          return res.status(400).json({
            success: false,
            field: "defaultQuota",
            message: "Enter a default quota greater than $0.",
          });
        }
        update.defaultQuota = quota;
      }
    }

    // Checked by hand, not left to the schema: the schema's 0-5 bounds would
    // catch 6 but not the coercions below.
    if (Object.prototype.hasOwnProperty.call(update, "maxOutreachAttempts")) {
      // Only numbers and numeric strings: Number(null), Number("") and
      // Number(true) are 0, 0 and 1, which would quietly save a cap nobody typed.
      const raw = update.maxOutreachAttempts;
      const numeric = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "");
      const cap = numeric ? Number(raw) : NaN;
      if (!Number.isInteger(cap) || cap < 0 || cap > 5) {
        return res.status(400).json({
          success: false,
          field: "maxOutreachAttempts",
          message: "Choose a whole number of vendors from 0 to 5.",
        });
      }
      update.maxOutreachAttempts = cap;
    }

    // By hand rather than left to the schema's min: 0 for the same coercion
    // reason as the cap -- an emptied field must not save as $0.
    if (Object.prototype.hasOwnProperty.call(update, "lowFundsThreshold")) {
      const raw = update.lowFundsThreshold;
      const amount = isNumberLike(raw) ? Number(raw) : NaN;
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({
          success: false,
          field: "lowFundsThreshold",
          message: policyFieldMessage("lowFundsThreshold"),
        });
      }
      update.lowFundsThreshold = amount;
    }

    for (const field of QUOTA_MAP_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(update, field) && !validQuotaMap(update[field])) {
        return res.status(400).json({
          success: false,
          field,
          message: "Each quota must be an amount greater than $0.",
        });
      }
    }

    const saved = await policyWriter.writePolicy({ landlordId: req.user.id,
      expectedRevision: req.body.expectedPolicyRevision, patch: update,
      actorId: req.user.id, actorRole: req.user.role || 'landlord', origin: 'policy_ui' });
    res.json({ success: true, data: saved.policy, reevaluating: saved.routingChanged });
    const { publish } = require('../services/realtime/liveEvents.service');
    publish(req.user.id, 'policy');
    publish(req.user.id, 'iris_policy_changes');
    if (saved.routingChanged) policyWriter.queueRefresh(saved.receiptId);
    return undefined;
  } catch (err) {
    if (err?.name === 'ValidationError' || err?.name === 'CastError') {
      const field = String(err.name === 'CastError' ? err.path : Object.keys(err.errors || {})[0]).split('.')[0];
      return res.status(400).json({ success: false, code: 'invalid_input', field, message: policyFieldMessage(field), retryAfterSeconds: null, currentPolicyRevision: null });
    }
    if (err?.status && err?.code) return res.status(err.status).json({ success: false, code: err.code,
      message: err.message, retryAfterSeconds: null, currentPolicyRevision: err.currentPolicyRevision ?? null, field: err.field ?? null });
    console.error("[upsertPolicy]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ---- DASHBOARD STATS ----
// Appointments whose next move belongs to the MANAGER.
//
// `proposed` is ambiguous on its own: it is the state an appointment is BORN in
// (waiting on the tenant to accept a window) and also the state a tenant
// DECLINE returns it to (waiting on the manager to re-coordinate a time).
// tenantConfirmation.respondedAt is the only field that separates them —
// `accepted` defaults to false, so it cannot. Counting bare `proposed` billed
// the manager for work the tenant still owed.
//
// `in_review` is excluded on purpose: it raises a completion_review
// ApprovalRequest (see ensureCompletionReviewApproval), so counting it here too
// would put one job on two badges and overstate the workload.
// `work_verifying` is excluded because the TENANT is the one being asked —
// the manager has nothing to do but wait.
const managerScheduleFilter = (landlordId) => ({
  landlordId,
  $or: [
    { status: "disputed" },
    { status: "proposed", "tenantConfirmation.respondedAt": { $ne: null } },
  ],
});

// A payout Stripe refused, one the landlord has to send by hand, and one
// waiting on the landlord's top-up. None resolves until the landlord acts.
const STUCK_PAYOUT_STATUSES = ["failed", "pending_manual", "awaiting_funds"];

const parseSeenAt = (value) => {
  const parsed = new Date(String(value || ""));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * Counts behind the landlord sidebar badges.
 *
 * TWO different things earn a badge here, and they are counted differently.
 *
 * WORK — items whose next action is the landlord's. Counted outright, and
 * cleared by being dealt with rather than by being looked at, so the badge can
 * never show 0 over three decisions that are still pending.
 *
 * ACTIVITY — money moving, and requests arriving. A completed payout is not a
 * problem to solve, and neither is a request that has only just come in; but
 * both are things the manager wants to notice. Counting them as work would
 * light those badges on every healthy job and teach the manager to ignore them,
 * so they are counted as UNREAD instead: rows written since the landlord last
 * opened that tab, cleared by opening it. The `*SeenAt` marks are owned by the
 * client, which is where "last opened" is actually observable.
 *
 * Deliberately NOT folded into getStats, which loads every property, every
 * request and the wallet. This runs on every navigation, so it is counts only,
 * each served off an existing index.
 */
exports.getBadgeCounts = async (req, res) => {
  try {
    const landlordId = req.user.id;
    const walletSeenAt = parseSeenAt(req.query.walletSeenAt);
    const requestsSeenAt = parseSeenAt(req.query.requestsSeenAt);
    const scheduleSeenAt = parseSeenAt(req.query.scheduleSeenAt);
    const syntheticPayout = require('../services/judgeSandbox/simulationScope.service')
      .syntheticManualPayoutBadgeExclusion(landlordId);
    const badgeLedgerFilter = syntheticPayout ? { $nor: [syntheticPayout] } : {};

    // Same sweep as the Decisions list, first, so the badge doesn't count a
    // quote approval the page no longer shows.
    await expireOrphanedQuoteApprovals(landlordId).catch((err) =>
      console.error("[getBadgeCounts] orphan sweep failed", err.message)
    );

    const [approvalCount, routingDecisions, schedule, stuckPayouts, ledger, walletUnread, requests, directDue, landlord] = await Promise.all([
      // Matches the Decisions page exactly -- pending approvals plus the
      // routing decisions derived from request state -- so the badge and the
      // list can never disagree.
      ApprovalRequest.countDocuments({ landlordId, status: "pending" }),
      listRoutingDecisions(landlordId),
      // UNREAD, not work — deliberately unlike decisions.
      //
      // The landlord schedule is a read-only view: AppointmentCard renders its
      // confirm/decline controls only for `audience === "tenant"`, so there is
      // nothing on that page a manager can click to resolve a dispute or
      // re-propose a time. Counting it as work produced a badge that survived
      // every visit because visiting was all the page allowed. Whatever needs
      // DECIDING still surfaces on Decisions Needed, and a dispute still shows
      // on the request itself.
      Appointment.countDocuments({
        ...managerScheduleFilter(landlordId),
        ...(scheduleSeenAt ? { updatedAt: { $gt: scheduleSeenAt } } : {}),
      }),
      LedgerEntry.countDocuments({
        landlordId,
        type: "payout",
        providerStatus: { $in: STUCK_PAYOUT_STATUSES },
        ...badgeLedgerFilter,
      }),
      LandlordLedger.findOne({ landlordId }).select("arrears").lean(),
      // No timestamp yet means the wallet has never been opened in this browser.
      // Treating everything as unread there would badge the entire history on
      // first login, so the first visit is what establishes the mark.
      walletSeenAt
        ? LedgerEntry.countDocuments({ landlordId, createdAt: { $gt: walletSeenAt }, ...badgeLedgerFilter })
        : 0,
      // Same rule for requests that have arrived since the tab was last opened.
      // Scoped to non-terminal ones: a request the tenant raised and cancelled
      // while the manager was away is not something to go and look at.
      requestsSeenAt
        ? MaintenanceRequest.countDocuments({
            landlordId,
            createdAt: { $gt: requestsSeenAt },
            status: { $nin: ["completed", "rejected", "cancelled"] },
          })
        : 0,
      // WORK, like stuck payouts: a finished direct-pay job the landlord still
      // owes a vendor for. Cleared by marking it paid, not by looking.
      countDirectPaymentsDue(landlordId),
      Landlord.findById(landlordId).select("paymentMode").lean(),
    ]);

    // Arrears is one problem however much is owed, so it adds one to the count
    // rather than a dollar figure. It means work is finished and unpaid, which
    // blocks the next booking until the landlord tops up.
    const owesMoney = Number(ledger?.arrears || 0) > 0 ? 1 : 0;
    const walletStuck = stuckPayouts + owesMoney + directDue;
    const decisions = approvalCount + routingDecisions.length;

    return res.json({
      success: true,
      data: {
        decisions,
        schedule,
        requests,
        wallet: walletStuck + walletUnread,
        // Broken out so the UI can describe the number honestly instead of
        // calling a completed payout a problem.
        walletBreakdown: { stuck: walletStuck, unread: walletUnread, directDue },
        // The sidebar calls the page "Payments" for a direct-pay landlord.
        paymentMode: landlordPaymentMode(landlord),
      },
    });
  } catch (err) {
    console.error("[getBadgeCounts]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Routing decisions derived from request state (Approve contact, paused
// requests). The Decisions page lists these alongside pending approvals.
exports.listRoutingDecisions = async (req, res) => {
  try {
    const data = await listRoutingDecisions(req.user.id);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("[listRoutingDecisions]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getStats = async (req, res) => {
  try {
    const landlordId = req.user.id;
    // Live portfolio only. A retired property or unit is kept for history but
    // is gone from every list and picker, so counting it here made the tiles
    // disagree with the Properties page.
    const properties = await Property.find({ landlordId, ...LIVE }).select("_id units");
    const propertyIds = properties.map((p) => p._id);
    const liveUnits = await Unit.find({ propertyId: { $in: propertyIds }, ...LIVE }).select("_id").lean();
    const unitCount = liveUnits.length;
    const liveUnitIds = new Set(liveUnits.map((u) => String(u._id)));

    // A moved-out tenant (inactive) keeps their account and history but no
    // longer lives anywhere, so they count toward none of these.
    const tenants = await Tenant.find({ landlord: landlordId, status: { $ne: "inactive" } })
      .select("unit moveOut")
      .lean();
    const tenantCount = tenants.length;
    const occupiedUnitCount = new Set(
      tenants.filter((t) => t.unit && liveUnitIds.has(String(t.unit))).map((t) => String(t.unit))
    ).size;
    const pendingMoveOutCount = tenants.filter((t) => t.moveOut?.status === "requested").length;

    const requests = await MaintenanceRequest.find({ landlordId })
      .select("status urgency category estimatedCost finalCost createdAt completedAt selectedVendorId")
      .lean();

    const byStatus = requests.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    const byCategory = requests.reduce((acc, r) => {
      acc[r.category || "Other"] = (acc[r.category || "Other"] || 0) + 1;
      return acc;
    }, {});

    // Spend means money actually spent: the agreed final cost of completed
    // work. A queued request carrying a vendor's quote is not spend, and the
    // quote is a ceiling anyway. Rejected/cancelled fall out by construction.
    // Nullish, not truthy — `finalCost: 0` is a real value (warranty, goodwill).
    const TERMINAL_UNSPENT = ["rejected", "cancelled"];
    const totalCost = requests
      .filter((r) => r.status === "completed")
      .reduce((acc, r) => acc + (r.finalCost ?? 0), 0);

    // Money promised but not yet realised, reported separately. This IS the
    // vendor's quote ceiling, so it is labelled as an upper bound in the UI.
    //
    // NEVER DELETE THIS in favour of ledger.held. It is computed independently,
    // by code that knows nothing about the ledger, which makes it the free
    // second opinion reconcileLedger checks the entire hold lifecycle against —
    // and the fallback for any landlord who has no ledger document yet.
    const committedCost = requests
      .filter(
        (r) => r.status !== "completed" && !TERMINAL_UNSPENT.includes(r.status) && r.selectedVendorId
      )
      .reduce((acc, r) => acc + (r.estimatedCost ?? 0), 0);

    const walletBalance = await getBalance(req.user.id).catch(() => null);

    // "Open" means NOT FINISHED. The dashboard tile labelled "Open Requests"
    // was reading requestCount — every request the landlord has ever had — so
    // completing, rejecting or cancelling a job left the number untouched and
    // it only ever climbed.
    //
    // Deliberately a wider set than intakeGuardrails' OPEN_REQUEST_STATUSES,
    // which omits `pending` because that cap counts requests already accepted
    // into the pipeline. From the landlord's side a pending request is very
    // much open — it is waiting on them.
    const TERMINAL_REQUEST_STATUSES = ["completed", "rejected", "cancelled"];
    const openRequests = requests.filter(
      (r) => !TERMINAL_REQUEST_STATUSES.includes(r.status)
    );
    const openRequestCount = openRequests.length;

    // Urgency counted over OPEN requests only, for the same reason: a resolved
    // emergency from three months ago is not something to badge today.
    const urgentCount = openRequests.filter((r) =>
      ["high", "emergency"].includes(r.urgency)
    ).length;

    // Twelve months backs the 6M/12M chart ranges; thirty days backs 7D/30D.
    // Bucketing rules live in trendBuckets, shared with the reports endpoint.
    const now = new Date();
    const months = monthlyTrend(requests, { now, months: 12 });
    const days = dailyTrend(requests, { now, days: 30 });

    return res.json({
      success: true,
      data: {
        propertyCount: properties.length,
        unitCount,
        tenantCount,
        occupiedUnitCount,
        pendingMoveOutCount,
        propertyIds,
        // Every request ever, kept because other callers may rely on it.
        requestCount: requests.length,
        // What the "Open Requests" tile actually means.
        openRequestCount,
        urgentCount,
        totalCost,
        committedCost,
        // Null when the landlord has never funded a wallet, so the dashboard
        // can fall back to the derived committedCost rather than showing $0.
        balance: walletBalance
          ? {
              available: fromCents(walletBalance.available),
              held: fromCents(walletBalance.held),
              arrears: fromCents(walletBalance.arrears),
              currency: walletBalance.currency,
            }
          : null,
        completedCount: requests.filter((r) => r.status === "completed").length,
        byStatus,
        byCategory,
        monthly: months,
        daily: days,
      },
    });
  } catch (err) {
    console.error("[getStats]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
