// Editing a property or unit after it exists: renovations, renumbering, a
// corrected or changed address. Before this the only way to change one was to
// delete it and add it again -- which the deletion guard now refuses for
// anything with tenants or history, so editing has to exist.
//
// Everything else references properties and units by id and looks the name up
// when it renders (requests, invites, tenants, the ledger scope, History), so a
// rename needs no data migration. Two things DO need care:
//
//   - geo is derived from the address, so a new address clears it rather than
//     leaving the completion geofence pointed at the old building.
//   - vendors with a booked job there read the address live on their job page.
//     They are told it changed. The email carries NO address -- the vendor
//     email privacy rule (see templates/vendorJobLinkEmail.js) holds even for a
//     vendor who has seen it; the job page shows the new one behind the token.

const mongoose = require("mongoose");
const Property = require("../../models/Property");
const Unit = require("../../models/Unit");
const Vendor = require("../../models/Vendor");
const Appointment = require("../../models/Appointment");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const { logAgentAction } = require("../audit/agentAction.service");
const { sendEmail } = require("../notification/email.service");
const { renderLayout, escapeHtml, INK, MUTED, SURFACE } = require("../notification/templates/emailLayout");
const { normalizeIdentifier, comparisonKey, validateUnitBatch } = require("../property/unitBatch.service");
const { MAX_NAME_LENGTH, MAX_ADDRESS_LENGTH } = require("../property/portfolioBatch.service");

const MAX_DESCRIPTION_LENGTH = 1000;

// Appointments a vendor is committed to and will travel to.
const BOOKED_APPOINTMENT_STATUSES = ["awaiting_tenant", "scheduled", "work_verifying", "in_review", "disputed"];

const fail = (status, message, extra = {}) => ({ error: { status, message, ...extra } });
const ARCHIVED_MESSAGE = "Archived items are kept read-only so their history stays as it was.";

/** Booked jobs at a property: what an address change would reach. */
async function findBookedJobs(propertyId) {
  const requests = await MaintenanceRequest.find({
    propertyId,
    status: { $nin: ["completed", "cancelled", "rejected"] },
  })
    .select("_id category")
    .lean();
  if (!requests.length) return [];

  const categoryById = new Map(requests.map((row) => [String(row._id), row.category]));
  const appointments = await Appointment.find({
    requestId: { $in: requests.map((row) => row._id) },
    status: { $in: BOOKED_APPOINTMENT_STATUSES },
  })
    .select("_id requestId vendorId")
    .lean();

  return appointments.map((row) => ({
    appointmentId: String(row._id),
    requestId: String(row.requestId),
    vendorId: row.vendorId ? String(row.vendorId) : null,
    category: categoryById.get(String(row.requestId)) || null,
  }));
}

async function loadOwnedProperty({ landlordId, id }) {
  if (!mongoose.isValidObjectId(id)) return null;
  return Property.findOne({ _id: id, landlordId }).lean();
}

function buildAddressChangedEmail({ vendorName, category, managerLabel }) {
  const job = category ? `${category.toLowerCase()} job` : "job";
  const subject = `Location updated for your ${job}`;
  const lines = [
    `Hi ${vendorName || "there"},`,
    "",
    `${managerLabel} updated the address for your upcoming ${job}.`,
    "Open the job link from your booking email (or your vendor hub) to see the new location before you head out.",
  ];
  const bodyHtml = `<tr><td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:16px 32px 24px 32px;font-family:Helvetica,Arial,sans-serif;">
  <h1 style="margin:0 0 10px 0;font-size:22px;line-height:28px;font-weight:700;color:${INK};">The job location changed</h1>
  <p style="margin:0 0 8px 0;font-size:15px;line-height:22px;color:${INK};">${escapeHtml(
    `${managerLabel} updated the address for your upcoming ${job}.`
  )}</p>
  <p style="margin:0;font-size:14px;line-height:21px;color:${MUTED};">Open the job link from your booking email, or your vendor hub, to see the new location before you head out.</p>
</td></tr>`;
  const html = renderLayout({
    title: subject,
    preheader: "Check the new location before you head out.",
    bodyHtml,
    footerHtml: `Sent by Artrelo on behalf of ${escapeHtml(managerLabel)}.`,
  });
  return { subject, text: lines.join("\n"), html };
}

// Non-fatal by design: the edit is already saved and correct. A failed email
// is logged; the vendor still sees the new address on their job page.
async function notifyVendorsOfAddressChange({ jobs, managerLabel }) {
  const vendorIds = [...new Set(jobs.map((job) => job.vendorId).filter(Boolean))];
  if (!vendorIds.length) return 0;
  const vendors = await Vendor.find({ _id: { $in: vendorIds } }).select("name email").lean();
  const byId = new Map(vendors.map((vendor) => [String(vendor._id), vendor]));

  let sent = 0;
  // One email per vendor per job: two jobs are two trips.
  for (const job of jobs) {
    const vendor = byId.get(job.vendorId);
    if (!vendor?.email) continue;
    try {
      const email = buildAddressChangedEmail({ vendorName: vendor.name, category: job.category, managerLabel });
      await sendEmail({ to: vendor.email, ...email });
      sent += 1;
    } catch (err) {
      console.error("[notifyVendorsOfAddressChange]", err?.message || err);
    }
  }
  return sent;
}

/**
 * PATCH a property. Only name, address and description are writable; landlordId,
 * units, geo and archivedAt never come from the body.
 * Returns { property, changed, notifiedVendors } or { error }.
 */
async function updateProperty({ landlordId, id, input = {}, managerLabel = "Your property manager" }) {
  const property = await loadOwnedProperty({ landlordId, id });
  if (!property) return fail(404, "Property not found");
  if (property.archivedAt) return fail(409, ARCHIVED_MESSAGE, { code: "archived" });

  const fields = {};
  const next = {};
  if (input.name !== undefined) {
    const name = normalizeIdentifier(input.name);
    if (!name) fields.name = "Enter a property name.";
    else if (name.length > MAX_NAME_LENGTH) fields.name = `Keep the name to ${MAX_NAME_LENGTH} characters or fewer.`;
    else next.name = name;
  }
  if (input.address !== undefined) {
    const address = normalizeIdentifier(input.address);
    if (!address) fields.address = "Enter the property's address.";
    else if (address.length > MAX_ADDRESS_LENGTH) {
      fields.address = `Keep the address to ${MAX_ADDRESS_LENGTH} characters or fewer.`;
    } else next.address = address;
  }
  if (input.description !== undefined) {
    const description = String(input.description ?? "").trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      fields.description = `Keep the description to ${MAX_DESCRIPTION_LENGTH} characters or fewer.`;
    } else next.description = description;
  }
  if (Object.keys(fields).length) return fail(422, "Check the highlighted fields.", { fields });

  // Same rule as adding: one live property per name, compared case-insensitively.
  // Excluding itself is what lets a case-only rename ("maple court" -> "Maple
  // Court") through.
  if (next.name && comparisonKey(next.name) !== comparisonKey(property.name)) {
    const others = await Property.find({ landlordId, archivedAt: null, _id: { $ne: property._id } })
      .select("name")
      .lean();
    if (others.some((other) => comparisonKey(other.name) === comparisonKey(next.name))) {
      return fail(409, "You already have a property with this name.", {
        fields: { name: "You already have a property with this name." },
      });
    }
  }

  const changed = Object.keys(next).filter((key) => (property[key] ?? "") !== next[key]);
  if (!changed.length) return { property, changed: [], notifiedVendors: 0 };

  const set = Object.fromEntries(changed.map((key) => [key, next[key]]));
  const addressChanged = changed.includes("address");
  const update = addressChanged ? { $set: set, $unset: { geo: 1 } } : { $set: set };
  await Property.updateOne({ _id: property._id, landlordId }, update);

  const before = Object.fromEntries(changed.map((key) => [key, property[key] ?? null]));
  await logAgentAction({
    landlordId,
    actor: "landlord",
    actionType: "property_updated",
    summary: `Property updated: ${changed.join(", ")}`,
    input: { propertyId: String(property._id), before },
    output: { after: set },
  });

  let notifiedVendors = 0;
  if (addressChanged) {
    try {
      const jobs = await findBookedJobs(property._id);
      notifiedVendors = await notifyVendorsOfAddressChange({ jobs, managerLabel });
    } catch (err) {
      console.error("[updateProperty] vendor notice failed", err?.message || err);
    }
  }

  const { geo, ...rest } = property;
  const updated = { ...rest, ...set, ...(addressChanged ? {} : { geo }) };
  return { property: updated, changed, notifiedVendors };
}

/** PATCH a unit's identifier, under the same rules as creating one. */
async function updateUnit({ landlordId, id, input = {} }) {
  if (!mongoose.isValidObjectId(id)) return fail(404, "Unit not found");
  const unit = await Unit.findById(id).lean();
  if (!unit) return fail(404, "Unit not found");
  const property = await Property.findOne({ _id: unit.propertyId, landlordId }).lean();
  if (!property) return fail(404, "Unit not found");
  if (unit.archivedAt || property.archivedAt) return fail(409, ARCHIVED_MESSAGE, { code: "archived" });

  const siblings = await Unit.find({ propertyId: property._id, archivedAt: null, _id: { $ne: unit._id } })
    .select("unitNumber")
    .lean();
  const [row] = validateUnitBatch(
    [input.unitNumber ?? ""],
    siblings.map((sibling) => sibling.unitNumber)
  ).rows;
  if (!row.valid) {
    const duplicate = row.errors.some((error) => error.code === "ALREADY_EXISTS");
    const message = duplicate ? "This property already has a unit with this number." : row.errors[0].message;
    return fail(duplicate ? 409 : 422, message, { fields: { unitNumber: message } });
  }
  if (row.name === unit.unitNumber) return { unit, changed: [] };

  await Unit.updateOne({ _id: unit._id }, { $set: { unitNumber: row.name } });
  await logAgentAction({
    landlordId,
    actor: "landlord",
    actionType: "unit_updated",
    summary: `Unit renamed from ${unit.unitNumber} to ${row.name}`,
    input: { unitId: String(unit._id), propertyId: String(property._id), before: { unitNumber: unit.unitNumber } },
    output: { after: { unitNumber: row.name } },
  });
  return { unit: { ...unit, unitNumber: row.name }, changed: ["unitNumber"] };
}

/** How many booked jobs would see a new address -- the edit dialog's warning. */
async function getEditImpact({ landlordId, id }) {
  const property = await loadOwnedProperty({ landlordId, id });
  if (!property) return null;
  const jobs = await findBookedJobs(property._id);
  return { bookedJobs: jobs.length };
}

module.exports = {
  BOOKED_APPOINTMENT_STATUSES,
  findBookedJobs,
  updateProperty,
  updateUnit,
  getEditImpact,
  buildAddressChangedEmail,
};
