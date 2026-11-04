const accounts = require("../services/billing/billingAccount.service");
const { billingSummary } = require("../services/billing/billingSummary.service");
const respond = (work) => async (req, res) => {
  try { res.json({ success: true, data: await work(req) }); }
  catch (error) {
    if (!error.status) console.error("[billing] request failed", error.code || "billing_error");
    res.status(error.status || 500).json({ success: false, code: error.code || "billing_unavailable",
      message: error.status ? error.message : "Billing is temporarily unavailable. Please try again." });
  }
};
exports.getBilling = respond((req) => billingSummary(req.user.id));
exports.acceptPricing = respond(async (req) => {
  await accounts.acceptPricing(req.user.id, req.body?.version, req.ip);
  return billingSummary(req.user.id);
});
exports.setupCard = respond((req) => accounts.setupCard(req.user.id, req.body?.attempt));
exports.refreshBilling = respond(async (req) => {
  await require("../services/billing/invoiceCollection.service").refreshLandlord(req.user.id);
  return billingSummary(req.user.id);
});
