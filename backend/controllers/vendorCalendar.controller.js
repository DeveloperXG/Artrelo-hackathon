const calendar = require("../services/vendor/vendorCalendar.service");
function failed(res, error) {
  if (!error.status) console.error("[vendorCalendar] operation failed", error.code || "calendar_error");
  return res.status(error.status || 500).json({ success: false, code: error.code || "calendar_error",
    message: error.status ? error.message : "The calendar could not be updated. Please try again." });
}
exports.listBusyTimes = async (req, res) => {
  try { return res.json({ success: true, data: await calendar.listBusyTimes(req.vendorIdentity._id) }); }
  catch (error) { return failed(res, error); }
};
exports.addBusyTime = async (req, res) => {
  try { return res.status(201).json({ success: true, data: await calendar.addBusyTime(req.vendorIdentity._id, req.body || {}) }); }
  catch (error) { return failed(res, error); }
};
exports.removeBusyTime = async (req, res) => {
  try { return res.json({ success: true, data: await calendar.removeBusyTime(req.vendorIdentity._id, req.params.ref) }); }
  catch (error) { return failed(res, error); }
};
exports.issueSchedulingLink = async (req, res) => {
  try {
    const rows = await require("../models/BookingPreparation").find({ identityId: req.vendorIdentity._id,
      active: true, phase: { $in: ["awaiting_vendor", "awaiting_tenant", "scheduled"] } });
    const row = rows.find(item => `JOB-${String(item.outreachId).slice(-6).toUpperCase()}` === String(req.params.ref).toUpperCase());
    if (!row) return res.status(404).json({ success: false, message: "No active proposal was found for this job." });
    return res.json({ success: true, data: { url: await require("../services/vendor/schedulingToken.service").issueSchedulingLink(row) } });
  } catch (error) { return failed(res, error); }
};
