const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const ctrl = require("../controllers/vendorHub.controller");
const { hubAuth } = require("../middleware/hubAuth.middleware");

// PUBLIC, like the vendor portal, and deliberately outside
// requireRegistrationOpen: a contractor signing in to see their own work is not
// registering, and the registration kill switch must not lock them out of jobs
// they have already accepted.

const WINDOW_MS = 15 * 60 * 1000;

// Tight, because this endpoint emails on demand. Loose limits here would make
// it a way to send mail to an address of the caller's choosing.
const loginLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many sign-in requests. Try again shortly." },
});

// Separate, and looser: exchanging a link is not a mail trigger, and a vendor
// double-clicking an email should not be locked out.
const enterLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Try again shortly." },
});

router.post("/login", loginLimiter, ctrl.requestLoginLink);
router.get("/session/:token", enterLimiter, ctrl.enterWithMagicToken);

// Everything below requires a hub session. hubAuth sets req.vendorIdentity and
// never req.user, so none of these can reach a landlord or tenant handler.
router.get("/me", hubAuth, ctrl.getHub);
const calendarCtrl = require("../controllers/vendorCalendar.controller");
router.get("/busy-times", hubAuth, calendarCtrl.listBusyTimes);
router.post("/busy-times", enterLimiter, hubAuth, calendarCtrl.addBusyTime);
router.delete("/busy-times/:ref", enterLimiter, hubAuth, calendarCtrl.removeBusyTime);
router.post("/jobs/:ref/scheduling-link", enterLimiter, hubAuth, calendarCtrl.issueSchedulingLink);
// The recovery path: re-issue a link to one of this vendor's own jobs. Rate
// limited because it rotates a credential on every call.
router.post("/jobs/:ref/link", enterLimiter, hubAuth, ctrl.issueJobLink);
// Bank details live on the vendor, not on a job — a job link dies at close and
// the vendor who most needs payout setup is the one whose job just closed.
router.post("/payouts/onboard", enterLimiter, hubAuth, ctrl.startPayouts);
// Change payout details after setup (Stripe-hosted).
router.post("/payouts/update-link", enterLimiter, hubAuth, ctrl.payoutUpdateLink);
router.post("/sign-out", hubAuth, ctrl.signOut);

module.exports = router;
