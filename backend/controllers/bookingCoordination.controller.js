const mongoose = require("mongoose");
const Preparation = require("../models/BookingPreparation");
const Request = require("../models/MaintenanceRequest");
const Outreach = require("../models/VendorOutreach");
const Notice = require("../models/CoordinationNotice");
const Landlord = require("../models/Landlord");
const Property = require("../models/Property");
const coordination = require("../services/vendor/bookingCoordination.service");
const { landlordView, tenantView } = require("../services/vendor/bookingPreparation.service");
const { resolveSchedulingLink } = require("../services/vendor/schedulingToken.service");
const { buildPublicBrief } = require("../services/vendor/vendorBrief.service");
const { nudge: nudgeNotices } = require("../services/vendor/coordinationNotices.service");
const GENERIC = { success: false, code: "invalid_link", message: "This link is not valid. It may have been replaced by a newer one." };
const TENANTS = ["tenant", "primary_tenant", "co-tenant"];
const LANDLORDS = ["landlord", "property_manager", "admin"];
const receipt = result => ({ proposalRef: String(result.change._id), revision: result.change.revision,
  status: result.change.status, duplicate: result.duplicate === true });
function failure(res, error) {
  if (!error.status) console.error("[bookingCoordination] operation failed", error.code || "coordination_error");
  return res.status(error.status || 500).json({ success: false, code: error.code || "coordination_error",
    message: error.status ? error.message : "The proposal could not be updated. Refresh and try again." });
}
async function ownedRequest(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  if (!TENANTS.includes(req.user.role) && !LANDLORDS.includes(req.user.role)) return null;
  return Request.findOne({ _id: req.params.id,
    [TENANTS.includes(req.user.role) ? "tenantId" : "landlordId"]: req.user.id }).lean();
}
async function view(row, audience) {
  if (!row) return null;
  const outreach = await Outreach.findById(row.outreachId).select("vendorNameSnapshot").lean();
  const data = { coordination: audience === "landlord" ? landlordView(row) : tenantView(row),
    vendorName: outreach?.vendorNameSnapshot || "Your vendor", vendorId: row.vendorId ? String(row.vendorId) : null };
  data.coordination.capabilities = await require("../services/vendor/bookingCapabilities.service").load(row, audience, { rescheduleEnabled: true });
  data.reschedules = await require("../services/vendor/bookingReschedule.service").view(row, audience);
  if (data.reschedules.some(change => change.active)) data.coordination.capabilities.canRequestReschedule = false;
  if (audience === "landlord") {
    const failures = await Notice.find({ preparationId: row._id, revision: row.revision, status: { $in: ["failed", "uncertain"] } })
      .select("_id audience status").lean();
    data.deliveryIssues = failures.map(item => ({ ref: String(item._id), audience: item.audience, status: item.status }));
  }
  return data;
}
exports.getCoordination = async (req, res) => {
  try {
    const request = await ownedRequest(req);
    if (!request) return res.status(404).json(GENERIC);
    const row = await Preparation.findOne({ requestId: request._id }).sort({ active: -1, createdAt: -1 });
    const audience = TENANTS.includes(req.user.role) ? "tenant" : "landlord";
    const data = await view(row, audience);
    return res.json({ success: true, data: audience === "landlord" ? { ...(data || { coordination: null, vendorName: "" }),
      history: await require("../services/vendor/negotiatedReturn.service").history(request._id) } : data });
  } catch (error) { return failure(res, error); }
};
exports.respond = async (req, res) => {
  try {
    const request = await ownedRequest(req);
    if (!request) return res.status(404).json(GENERIC);
    const row = await Preparation.findOne({ requestId: request._id, active: true });
    if (!row) return res.status(404).json(GENERIC);
    const body = req.body || {};
    const actor = TENANTS.includes(req.user.role) ? "tenant" : "landlord";
    let changeReceipt = null;
    const allowedKeys = { request_reschedule: ['action', 'revision', 'reason', 'windows', 'clientActionId'],
      respond_reschedule: ['action', 'proposalRef', 'expectedRevision', 'slotKey', 'accepted'], decline_reschedule: ['action', 'proposalRef', 'expectedRevision'] }[body.action];
    if (allowedKeys && Object.keys(body).some(key => !allowedKeys.includes(key))) return res.status(400).json({ success: false, code: 'unsupported_reschedule_fields', message: 'This visit change contains unsupported fields.' });
    if (body.action === "request_reschedule") {
      if (actor !== "landlord") return res.status(403).json({ success: false, code: "reschedule_party_required", message: "Only the owning manager can start this change request." });
      changeReceipt = receipt(await require("../services/vendor/bookingReschedule.service").open({ preparationId: row._id,
        actor: { role: actor, id: req.user.id }, revision: body.revision, reason: body.reason, windows: body.windows, clientActionId: body.clientActionId }));
    } else if (["respond_reschedule", "decline_reschedule"].includes(body.action)) {
      changeReceipt = receipt(await require("../services/vendor/bookingReschedule.service").respond({ preparationId: row._id, actor: { role: actor, id: req.user.id },
        proposalRef: body.proposalRef, expectedRevision: body.expectedRevision, action: body.action === "decline_reschedule" ? "decline" : "tenant_respond",
        slotKey: body.slotKey, accepted: body.accepted }));
    } else if (body.action === "confirm") {
      if (actor === "landlord" && body.accessConfirmed !== true) {
        return res.status(400).json({ success: false, message: "Confirm that you have the tenant's permission for this visit." });
      }
      await coordination.confirmTime({ preparationId: row._id, revision: body.revision, actor, actorId: req.user.id });
    } else if (body.action === "alternatives") {
      await coordination.proposeAlternatives({ preparationId: row._id, revision: body.revision, windows: body.windows, actor });
    } else return res.status(400).json({ success: false, message: "Choose confirm or alternatives." });
    const fresh = await Preparation.findOne({ requestId: request._id }).sort({ active: -1, createdAt: -1 });
    return res.json({ success: true, data: { ...await view(fresh, actor), ...(changeReceipt ? { receipt: changeReceipt } : {}) } });
  } catch (error) { return failure(res, error); }
};
exports.retryNotice = async (req, res) => {
  try {
    if (!LANDLORDS.includes(req.user.role)) return res.status(404).json(GENERIC);
    const request = await ownedRequest(req);
    if (!request || !mongoose.isValidObjectId(req.params.notice)) return res.status(404).json(GENERIC);
    const preparations = await Preparation.find({ requestId: request._id }).select("_id").lean();
    const changed = await Notice.findOneAndUpdate({ _id: req.params.notice, preparationId: { $in: preparations.map(row => row._id) },
      status: { $in: ["failed", "uncertain"] } }, { $set: { status: "pending", attempts: 0, nextAttemptAt: new Date(), errorCode: null } });
    if (!changed) return res.status(404).json(GENERIC);
    nudgeNotices(); return res.json({ success: true });
  } catch (error) { return failure(res, error); }
};
exports.getVendorCoordination = async (req, res) => {
  try {
    const row = await resolveSchedulingLink(req.params.token);
    if (!row) return res.status(404).json(GENERIC);
    const request = await Request.findById(row.requestId).lean();
    const outreach = await Outreach.findById(row.outreachId).lean();
    const landlord = await Landlord.findById(row.landlordId).select("firstName lastName companyName").lean();
    const property = request.propertyId ? await Property.findById(request.propertyId).select("city address").lean() : null;
    const brief = buildPublicBrief({ request, outreach, landlord, property });
    const coordinationView = tenantView(row);
    coordinationView.capabilities = await require("../services/vendor/bookingCapabilities.service").load(row, "vendor", { rescheduleEnabled: true });
    return res.json({ success: true, data: { coordination: coordinationView, brief,
      reschedules: await require("../services/vendor/bookingReschedule.service").view(row, "vendor") } });
  } catch (error) { return failure(res, error); }
};
exports.respondVendor = async (req, res) => {
  try {
    const row = await resolveSchedulingLink(req.params.token);
    if (!row) return res.status(404).json(GENERIC);
    const vendorKeys = { confirm_reschedule: ['action', 'proposalRef', 'expectedRevision', 'start', 'durationMinutes'],
      decline_reschedule: ['action', 'proposalRef', 'expectedRevision'] }[req.body?.action];
    if (req.body?.action && !vendorKeys && req.body.action !== 'propose_time') return res.status(400).json({ success: false, code: 'invalid_reschedule_action', message: 'Choose a supported visit response.' });
    if (vendorKeys && Object.keys(req.body).some(key => !vendorKeys.includes(key))) return res.status(400).json({ success: false, code: 'unsupported_reschedule_fields', message: 'This visit change contains unsupported fields.' });
    let changeReceipt = null;
    if (["confirm_reschedule", "decline_reschedule"].includes(req.body?.action)) {
      changeReceipt = receipt(await require("../services/vendor/bookingReschedule.service").respond({ preparationId: row._id,
        actor: { role: "vendor", id: row.identityId }, proposalRef: req.body.proposalRef, expectedRevision: req.body.expectedRevision,
        action: req.body.action === "decline_reschedule" ? "decline" : "vendor_confirm", start: req.body.start, durationMinutes: req.body.durationMinutes }));
    } else await coordination.proposeVendorTime({ preparationId: row._id, revision: req.body?.revision,
      start: req.body?.start, durationMinutes: Number(req.body?.durationMinutes) });
    // Proposing a time retires this revision's credential. Return the committed
    // result rather than attempting to authenticate the used link again.
    const fresh = await Preparation.findById(row._id);
    const coordinationView = tenantView(fresh);
    coordinationView.capabilities = await require("../services/vendor/bookingCapabilities.service").load(fresh, "vendor", { rescheduleEnabled: true });
    return res.json({ success: true, data: { coordination: coordinationView,
      reschedules: await require("../services/vendor/bookingReschedule.service").view(fresh, "vendor"), ...(changeReceipt ? { receipt: changeReceipt } : {}) } });
  } catch (error) { return failure(res, error); }
};
exports.interpretAvailability = async (req, res) => {
  try {
    const request = req.params.token ? null : await ownedRequest(req);
    const preparation = req.params.token ? await resolveSchedulingLink(req.params.token) : null;
    if (!request && !preparation) return res.status(404).json(GENERIC);
    if (Object.keys(req.body || {}).some(key => !['text', 'timeZone'].includes(key))) return res.status(400).json({ success: false, code: 'unsupported_availability_fields', message: 'Only availability text and its time zone are supported.' });
    const data = await require('../services/vendor/availabilityLanguage.service').interpret({ text: req.body?.text, timeZone: req.body?.timeZone });
    return res.json({ success: true, data });
  } catch (error) { return failure(res, error); }
};
exports.returnToVendor = async (req, res) => {
  try {
    if (!LANDLORDS.includes(req.user.role)) return res.status(404).json(GENERIC);
    const request = await ownedRequest(req);
    if (!request || !mongoose.isValidObjectId(req.body?.outreachRef)) return res.status(404).json(GENERIC);
    const data = await require("../services/vendor/negotiatedReturn.service").returnToVendor({
      requestId: request._id, landlordId: req.user.id, outreachRef: req.body.outreachRef,
      amount: req.body.amount, start: req.body.start, durationMinutes: Number(req.body.durationMinutes), note: req.body.note });
    return res.json({ success: true, data });
  } catch (error) { return failure(res, error); }
};
