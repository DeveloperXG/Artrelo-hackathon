// Deleting a property or unit, and the move-out flow that has to come first.
//
// Deletion used to be unconditional: Unit.deleteMany and done. Every tenant on
// the unit was left pointing at a row that no longer existed, kept filing
// requests that carried no unit or property (unroutable, invisible under any
// property), and any outstanding invite code still signed new tenants into the
// ghost. The only guard was a confirm dialog.
//
// So deletion is RESTRICTED here, server-side, the way a foreign key with
// ON DELETE RESTRICT is -- the dialog only explains what this file decides:
//
//   - attached tenants (pending or active) block. They are asked to move out,
//     and the unit unlocks once nobody is linked to it.
//   - open requests block. They carry live appointments and held money; the
//     job is finished or cancelled first.
//   - once clear, a target with ANY request history is archived, not deleted.
//     Past requests, payments and ledger entries reference it by id, and the
//     History page has to keep resolving it. No history -> a real delete.

const mongoose = require("mongoose");
const Property = require("../../models/Property");
const Unit = require("../../models/Unit");
const Tenant = require("../../models/Tenant");
const InviteCode = require("../../models/Code");
const Landlord = require("../../models/Landlord");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const { notifyUser } = require("../notification/notify.service");

// A request in any other status is still in play.
const CLOSED_REQUEST_STATUSES = ["completed", "cancelled", "rejected"];
// "inactive" is what a completed move-out leaves behind.
const ATTACHED_TENANT_STATUSES = ["pending", "active"];

const unitLabel = (unit) => (unit ? `Unit ${unit.unitNumber}` : "this unit");

/**
 * The property or unit being retired, scoped to the landlord. Returns null for
 * anything they don't own, so another landlord's id reads exactly like one
 * that doesn't exist.
 */
async function resolveTarget({ landlordId, kind, id }) {
  if (!mongoose.isValidObjectId(id)) return null;

  if (kind === "property") {
    const property = await Property.findOne({ _id: id, landlordId }).lean();
    if (!property) return null;
    const units = await Unit.find({ propertyId: property._id }).select("_id unitNumber archivedAt").lean();
    return { kind, property, unit: null, units, label: property.name };
  }

  const unit = await Unit.findById(id).lean();
  if (!unit) return null;
  const property = await Property.findOne({ _id: unit.propertyId, landlordId }).lean();
  if (!property) return null;
  return { kind: "unit", property, unit, units: [unit], label: unitLabel(unit) };
}

// Requests that belong to the target. A property also matches on propertyId so
// a request that somehow lost its unit still counts against its building.
function requestScope(target) {
  const unitIds = target.units.map((unit) => unit._id);
  return target.kind === "property"
    ? { $or: [{ propertyId: target.property._id }, { unitId: { $in: unitIds } }] }
    : { unitId: target.unit._id };
}

function projectTenant(tenant, unitsById) {
  return {
    _id: String(tenant._id),
    name: [tenant.firstName, tenant.lastName].filter(Boolean).join(" ") || tenant.email,
    email: tenant.email,
    unitLabel: unitLabel(unitsById.get(String(tenant.unit))),
    moveOut: tenant.moveOut
      ? { status: tenant.moveOut.status, requestedAt: tenant.moveOut.requestedAt || null }
      : null,
  };
}

/**
 * What stands between the landlord and deleting this target.
 * Returns null when the target isn't theirs.
 */
async function checkDeletion({ landlordId, kind, id }) {
  const target = await resolveTarget({ landlordId, kind, id });
  if (!target) return null;

  const scope = requestScope(target);
  const unitIds = target.units.map((unit) => unit._id);
  const [tenants, openRequests, historyRow] = await Promise.all([
    Tenant.find({ unit: { $in: unitIds }, status: { $in: ATTACHED_TENANT_STATUSES } })
      .select("firstName lastName email unit moveOut status")
      .lean(),
    MaintenanceRequest.countDocuments({ ...scope, status: { $nin: CLOSED_REQUEST_STATUSES } }),
    MaintenanceRequest.exists(scope),
  ]);

  const unitsById = new Map(target.units.map((unit) => [String(unit._id), unit]));
  const blockers = {
    tenants: tenants.map((tenant) => projectTenant(tenant, unitsById)),
    openRequests,
  };

  return {
    target,
    blockers,
    hasHistory: Boolean(historyRow),
    blocked: blockers.tenants.length > 0 || openRequests > 0,
  };
}

/** The landlord-facing shape of a check: no Mongo documents, just the answer. */
function serializeCheck(check) {
  return {
    kind: check.target.kind,
    label: check.target.label,
    propertyId: String(check.target.property._id),
    blocked: check.blocked,
    blockers: check.blockers,
    hasHistory: check.hasHistory,
    // What confirming will actually do, so the dialog can say so up front.
    action: check.blocked ? null : check.hasHistory ? "archive" : "delete",
  };
}

/**
 * Retire a target that checkDeletion found clear: archive when it has history,
 * delete when it has none. Outstanding invite codes go either way -- a code for
 * a retired unit would sign a new tenant into it.
 *
 * Check-then-act is not atomic: a tenant redeeming an invite in the gap
 * between the check and the code deletion could still land. That needs an
 * outstanding code AND a signup in the same few milliseconds as the landlord's
 * click; the invite delete is first so the window is as small as it can be.
 */
async function retireTarget(check) {
  const { target, hasHistory } = check;
  const unitIds = target.units.map((unit) => unit._id);

  await InviteCode.deleteMany(
    target.kind === "property" ? { propertyId: target.property._id } : { unitId: target.unit._id }
  );

  if (hasHistory) {
    const now = new Date();
    if (target.kind === "property") {
      await Unit.updateMany({ _id: { $in: unitIds }, archivedAt: null }, { $set: { archivedAt: now } });
      await Property.updateOne({ _id: target.property._id }, { $set: { archivedAt: now } });
    } else {
      await Unit.updateOne({ _id: target.unit._id }, { $set: { archivedAt: now } });
    }
    return { action: "archived" };
  }

  if (target.kind === "property") {
    await Unit.deleteMany({ propertyId: target.property._id });
    await Landlord.findByIdAndUpdate(target.property.landlordId, {
      $pull: { properties: target.property._id },
    });
    await Property.deleteOne({ _id: target.property._id });
  } else {
    await Property.updateOne({ _id: target.property._id }, { $pull: { units: target.unit._id } });
    await Unit.deleteOne({ _id: target.unit._id });
  }
  return { action: "deleted" };
}

/**
 * Ask every tenant blocking this target to move out. Safe to call again as a
 * resend: tenants already asked keep their original requestedAt, and everyone
 * still attached is re-notified.
 */
async function sendMoveOutNotices({ landlordId, kind, id, actorUserId = null }) {
  const check = await checkDeletion({ landlordId, kind, id });
  if (!check) return null;

  const tenants = check.blockers.tenants;
  if (!tenants.length) return { check, notified: 0 };

  const now = new Date();
  await Tenant.updateMany(
    {
      _id: { $in: tenants.map((tenant) => tenant._id) },
      status: { $in: ATTACHED_TENANT_STATUSES },
      "moveOut.status": { $ne: "requested" },
    },
    {
      $set: {
        moveOut: {
          status: "requested",
          reason: check.target.kind === "property" ? "property_retired" : "unit_retired",
          requestedAt: now,
          requestedBy: actorUserId,
          completedAt: null,
          completedBy: null,
          fromUnit: null,
        },
      },
    }
  );

  const landlord = await Landlord.findById(landlordId).select("firstName lastName companyName").lean();
  const sender =
    landlord?.companyName ||
    [landlord?.firstName, landlord?.lastName].filter(Boolean).join(" ") ||
    "Your property manager";
  const place = check.target.kind === "property" ? check.target.property.name : null;

  await Promise.all(
    tenants.map((tenant) => {
      const where = place ? `${tenant.unitLabel} at ${place}` : tenant.unitLabel;
      const message =
        `${sender} is retiring ${where} on Artrelo and has asked its tenants to move out. ` +
        "Once you've moved out, open your tenant portal and confirm it. " +
        "Your past requests stay available to you.";
      return notifyUser({
        userId: tenant._id,
        type: "tenant_move_out_requested",
        title: "Please confirm your move-out",
        message,
        metadata: { action: "move_out", actionUrl: "/portal", priority: "high" },
        email: tenant.email,
        emailSubject: `Move-out request for ${where}`,
      });
    })
  );

  return { check, notified: tenants.length };
}

/**
 * Unlink a tenant from their unit. One function for both paths: the tenant
 * confirming a requested move-out, and the landlord moving them out directly
 * (someone who left without confirming).
 *
 * Refused while the tenant still has open requests on the unit -- the job is
 * at their door, and finishing or cancelling it comes first.
 */
async function completeMoveOut({ tenantId, landlordId = null, by }) {
  if (!mongoose.isValidObjectId(tenantId)) return { error: { status: 404, message: "Tenant not found" } };

  const filter = landlordId ? { _id: tenantId, landlord: landlordId } : { _id: tenantId };
  const tenant = await Tenant.findOne(filter).select("unit status moveOut").lean();
  if (!tenant) return { error: { status: 404, message: "Tenant not found" } };

  // Already unlinked. Idempotent, so a double click or a retry is harmless.
  if (!tenant.unit || tenant.status === "inactive") return { tenant, already: true };

  // A tenant can only confirm a move-out they were asked for; the landlord can
  // move anyone out.
  if (by === "tenant" && tenant.moveOut?.status !== "requested") {
    return { error: { status: 409, code: "no_move_out_requested", message: "No move-out has been requested." } };
  }

  const openRequests = await MaintenanceRequest.countDocuments({
    tenantId: tenant._id,
    unitId: tenant.unit,
    status: { $nin: CLOSED_REQUEST_STATUSES },
  });
  if (openRequests > 0) {
    return {
      error: {
        status: 409,
        code: "open_requests",
        message: `${openRequests} request${openRequests === 1 ? " is" : "s are"} still open for this unit. Finish or cancel ${
          openRequests === 1 ? "it" : "them"
        } before moving out.`,
        openRequests,
      },
    };
  }

  const now = new Date();
  // Conditional on the unit still being the one read above, so two racing
  // completions can't both report success against different states.
  const updated = await Tenant.findOneAndUpdate(
    { _id: tenant._id, unit: tenant.unit },
    {
      $set: {
        status: "inactive",
        unit: null,
        moveOut: {
          status: "completed",
          reason: tenant.moveOut?.reason || "landlord",
          requestedAt: tenant.moveOut?.requestedAt || null,
          requestedBy: tenant.moveOut?.requestedBy || null,
          completedAt: now,
          completedBy: by,
          fromUnit: tenant.unit,
        },
      },
    },
    { new: true }
  ).lean();

  return { tenant: updated || tenant, already: !updated };
}

/**
 * Whether a tenant can still file requests. A tenant with no unit, a retired
 * unit, or an inactive profile would create a request with no unit and no
 * property: unroutable, and invisible under every property.
 */
function tenantUnitProblem(tenant) {
  if (!tenant) return null;
  const unit = tenant.unit;
  if (tenant.status === "inactive" || !unit || (typeof unit === "object" && unit.archivedAt)) {
    return {
      status: 409,
      code: "tenant_no_unit",
      message: "You're not linked to a unit. Ask your property manager for a new invite.",
    };
  }
  return null;
}

module.exports = {
  CLOSED_REQUEST_STATUSES,
  ATTACHED_TENANT_STATUSES,
  checkDeletion,
  serializeCheck,
  retireTarget,
  sendMoveOutNotices,
  completeMoveOut,
  tenantUnitProblem,
};
