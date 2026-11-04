const express = require("express");
const router = express.Router();
const isAuth = require("../middleware/auth.middleware").userAuth;
const { authorize } = require("../middleware/authorization.middleware");
const ctrl = require("../controllers/landlord.controller");
const requestCtrl = require("../controllers/request.controller");
const ledgerCtrl = require("../controllers/ledger.controller");
const reportsCtrl = require("../controllers/reports.controller");
const betaCtrl = require("../controllers/beta.controller");
router.use('/iris', require('./iris.routes').createLandlordIrisRouter());

const landlordOnly = authorize(["landlord", "property_manager", "admin"]);
const billingCtrl = require("../controllers/billing.controller");
const billingLimiter = require("express-rate-limit")({ windowMs: 15 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false });
router.get("/billing", isAuth, landlordOnly, billingCtrl.getBilling);
router.post("/billing/accept", isAuth, landlordOnly, billingLimiter, billingCtrl.acceptPricing);
router.post("/billing/setup", isAuth, landlordOnly, billingLimiter, billingCtrl.setupCard);
router.post("/billing/refresh", isAuth, landlordOnly, billingLimiter, billingCtrl.refreshBilling);

// The landlord's own free beta and the founding agreement.
router.get("/beta", isAuth, landlordOnly, betaCtrl.getBeta);
router.post("/beta/agreement", isAuth, landlordOnly, betaCtrl.postAgreement);
router.post("/beta/decline", isAuth, landlordOnly, betaCtrl.postDecline);

// Properties
router.get("/properties", isAuth, landlordOnly, ctrl.listProperties);
router.post("/properties", isAuth, landlordOnly, ctrl.createProperty);
router.patch("/properties/:id", isAuth, landlordOnly, ctrl.updateProperty);
router.get("/properties/:id/edit-impact", isAuth, landlordOnly, ctrl.propertyEditImpact);
router.get("/properties/:id/deletion-check", isAuth, landlordOnly, ctrl.propertyDeletionCheck);
router.delete("/properties/:id", isAuth, landlordOnly, ctrl.deleteProperty);

// Portfolio import: properties and their units in one pass. Registered before
// the /properties/:propertyId/... routes below only for readability — Express
// matches "/properties/import" literally, so there is no ambiguity with an id.
router.post("/properties/import/validate", isAuth, landlordOnly, ctrl.validatePortfolio);
router.post("/properties/import", isAuth, landlordOnly, ctrl.importPortfolio);

// Units
router.get("/units", isAuth, landlordOnly, ctrl.listUnits);
router.post("/units", isAuth, landlordOnly, ctrl.createUnit);
router.patch("/units/:id", isAuth, landlordOnly, ctrl.updateUnit);
router.get("/units/:id/deletion-check", isAuth, landlordOnly, ctrl.unitDeletionCheck);
router.delete("/units/:id", isAuth, landlordOnly, ctrl.deleteUnit);

// Bulk units. Nested under the property because the property is what scopes
// both authorization and the collision check — a batch means nothing without
// knowing which property it lands in.
//
// /validate is the dry run the review table calls; /bulk is the commit. Bulk
// creation must never be dozens of POSTs to /units: that is N round trips, N
// chances to half-succeed, and no way to detect a duplicate across them.
router.post(
  "/properties/:propertyId/units/bulk/validate",
  isAuth,
  landlordOnly,
  ctrl.validateUnitsBulk
);
router.post("/properties/:propertyId/units/bulk", isAuth, landlordOnly, ctrl.createUnitsBulk);

// Invite codes
router.post("/invite-codes", isAuth, landlordOnly, ctrl.generateInviteCode);
router.get("/invite-codes", isAuth, landlordOnly, ctrl.listInviteCodes);
router.delete("/invite-codes/:id", isAuth, landlordOnly, ctrl.deleteInviteCode);

// Tenants
router.get("/tenants", isAuth, landlordOnly, ctrl.listTenants);
// Move-out: the step that unblocks deleting an occupied property or unit.
router.post("/tenants/move-out-notice", isAuth, landlordOnly, ctrl.sendMoveOutNotice);
router.post("/tenants/:id/move-out", isAuth, landlordOnly, ctrl.moveOutTenant);

// Vendors
router.get("/vendors", isAuth, landlordOnly, ctrl.listVendors);
router.post("/vendors", isAuth, landlordOnly, ctrl.createVendor);
router.patch("/vendors/:id", isAuth, landlordOnly, ctrl.updateVendor);
router.delete("/vendors/:id", isAuth, landlordOnly, ctrl.deleteVendor);

// Policy
router.get("/policy", isAuth, landlordOnly, ctrl.getPolicy);
router.put("/policy", isAuth, landlordOnly, ctrl.upsertPolicy);
router.get("/routing-setup", isAuth, landlordOnly, ctrl.getRoutingSetup);

// Requests
router.get('/iris-activity', isAuth, landlordOnly, require('../controllers/irisActivity.controller').list);
router.get('/requests/:id/iris-activity', isAuth, landlordOnly, require('../controllers/irisActivity.controller').detail);
router.post('/requests/:id/intake-review', isAuth, landlordOnly, require('../controllers/requestWorkflow.controller').reviewIntake);
router.post('/requests/:id/safety-review', isAuth, landlordOnly, require('../controllers/requestWorkflow.controller').reviewSafety);
router.get("/requests", isAuth, landlordOnly, requestCtrl.landlordGetRequests);
router.get("/requests/:id/work-record", isAuth, landlordOnly, require("../controllers/workRecord.controller").getWorkRecord);
router.get("/requests/:id/quote-reviews", isAuth, landlordOnly, require("../controllers/quoteReview.controller").getReviews);
router.post("/requests/:id/quote-reviews/:stage/:subjectId/reopen", isAuth, landlordOnly, require("../controllers/quoteReview.controller").reopenReview);
router.get("/archive", isAuth, landlordOnly, requestCtrl.getLandlordArchive);
router.post(
  "/requests/:id/vendor-recommendations",
  isAuth,
  landlordOnly,
  requestCtrl.generateVendorRecommendations
);
router.get(
  "/requests/:id/vendor-recommendations",
  isAuth,
  landlordOnly,
  requestCtrl.getVendorRecommendations
);
router.post(
  "/requests/:id/vendor-recommendations/:vendorId/approve-contact",
  isAuth,
  landlordOnly,
  requestCtrl.approveVendorRecommendationContact
);
router.put(
  "/requests/:id/vendor-recommendations/:vendorId/draft",
  isAuth,
  landlordOnly,
  requestCtrl.updateVendorRecommendationDraft
);
router.post(
  "/requests/:id/vendor-recommendations/:vendorId/reject",
  isAuth,
  landlordOnly,
  requestCtrl.rejectVendorRecommendation
);
router.post(
  "/requests/:id/vendor-recommendations/manual-assignment",
  isAuth,
  landlordOnly,
  requestCtrl.markManualVendorAssignmentRequired
);

// Vendor outreach
router.get(
  "/requests/:id/vendor-outreach",
  isAuth,
  landlordOnly,
  requestCtrl.listVendorOutreach
);
router.post(
  "/requests/:id/vendor-recommendations/:vendorId/resend-outreach",
  isAuth,
  landlordOnly,
  requestCtrl.resendVendorOutreach
);
router.post(
  "/requests/:id/vendor-outreach/:outreachId/cancel-scheduled",
  isAuth,
  landlordOnly,
  requestCtrl.cancelScheduledOutreach
);
router.post(
  "/requests/:id/vendor-outreach/:outreachId/dismiss-response",
  isAuth,
  landlordOnly,
  requestCtrl.dismissVendorResponse
);

router.put("/requests/:id/approve", isAuth, landlordOnly, requestCtrl.putMarkRequestApproved);
router.put("/requests/:id/reject", isAuth, landlordOnly, requestCtrl.putMarkRequestRejected);
// Withdraw a rejection, or accept the tenant's appeal (same action).
router.put("/requests/:id/reopen", isAuth, landlordOnly, requestCtrl.reopenRejectedRequest);
router.put("/requests/:id/appeal/decline", isAuth, landlordOnly, requestCtrl.declineRequestAppeal);
router.put("/requests/:id/assign", isAuth, landlordOnly, requestCtrl.putMarkRequestAssigned);
router.put("/requests/:id/in-progress", isAuth, landlordOnly, requestCtrl.putMarkInProgress);
router.put("/requests/:id/complete", isAuth, landlordOnly, requestCtrl.putMarkRequestCompleted);

// Routing decisions derived from request state (Approve contact, paused).
router.get("/decisions/routing", isAuth, landlordOnly, ctrl.listRoutingDecisions);

// Approval requests
router.get("/approval-requests", isAuth, landlordOnly, requestCtrl.listApprovalRequests);
router.post("/approval-requests", isAuth, landlordOnly, requestCtrl.createApprovalRequest);
router.put("/approval-requests/:id/decision", isAuth, landlordOnly, requestCtrl.decideApprovalRequest);

// Agent action logs
router.get("/agent-action-logs", isAuth, landlordOnly, requestCtrl.listAgentActionLogs);

// Appointments
router.get("/appointments", isAuth, landlordOnly, requestCtrl.listAppointments);
router.post("/appointments", isAuth, landlordOnly, requestCtrl.createAppointment);
router.put("/appointments/:id", isAuth, landlordOnly, requestCtrl.updateAppointment);
// A booking that went wrong: confirm the time for a silent tenant, re-route a
// no-show or unconfirmed visit to the next vendor, or dismiss a no-show report.
router.post("/appointments/:id/resolve", isAuth, landlordOnly, requestCtrl.resolveAppointment);

// Stats
router.get("/stats", isAuth, landlordOnly, ctrl.getStats);
// Reports: spend, volume, speed and vendor performance over a date range.
router.get("/reports", isAuth, landlordOnly, reportsCtrl.getReport);
// Sidebar badges. Counts only — called on every navigation, so it must stay
// cheap. See the comment on getBadgeCounts for what does and does not count.
router.get("/badge-counts", isAuth, landlordOnly, ctrl.getBadgeCounts);

// Wallet. Deliberately NOT under /api/v1/payments — that surface and
// services/payment/ mean tenant RENT, a different product with a different
// counterparty.
router.get("/ledger", isAuth, landlordOnly, ledgerCtrl.getLedger);
// Card top-up: mints a PaymentIntent. The ledger is credited by the
// payment_intent.succeeded webhook, never here.
router.post("/ledger/deposits/intent", isAuth, landlordOnly, ledgerCtrl.createDepositIntentHandler);
// Retired: answers 410. An external "transfer" credited money Stripe never had.
router.post("/ledger/deposits", isAuth, landlordOnly, ledgerCtrl.createDeposit);
// Direct pay: the landlord paid the vendor themselves on a finished job.
router.put("/appointments/:id/direct-payment", isAuth, landlordOnly, ledgerCtrl.markDirectPaymentPaid);
router.put("/ledger/entries/:id/mark-paid", isAuth, landlordOnly, ledgerCtrl.markPaid);
router.post("/ledger/entries/:id/retry", isAuth, landlordOnly, ledgerCtrl.retryPayout);

module.exports = router;
