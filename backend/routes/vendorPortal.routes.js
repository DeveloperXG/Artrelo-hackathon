const express = require("express");
const multer = require("multer");
const router = express.Router();
const ctrl = require("../controllers/vendorPortal.controller");
const completionCtrl = require("../controllers/vendorCompletion.controller");
const {
  briefLimiter,
  respondLimiter,
  counterOfferLimiter,
  completionReadLimiter,
  completionUploadLimiter,
  completionSubmitLimiter,
} = require("../middleware/vendorPortalRateLimit.middleware");
const { requireJobToken } = require("../middleware/jobToken.middleware");

// PUBLIC. No userAuth, no apiKeyAuth, and deliberately NOT behind
// requireRegistrationOpen — a vendor responding to a job is not registering,
// and the registration kill switch must not take this surface down.
//
// The magic-link token is the authorization. See vendorPortal.controller.js.
router.get("/:token", briefLimiter, ctrl.getOutreachBrief);
router.post("/:token/respond", respondLimiter, ctrl.submitOutreachResponse);
// Separate purpose-limited capability; never reopens the original /respond.
router.get("/:token/quote-clarification", briefLimiter, require("../controllers/quoteClarification.controller").get);
router.post("/:token/quote-clarification", respondLimiter, require("../controllers/quoteClarification.controller").submit);

// The counter-offer round. Deliberately NOT folded into /respond: that handler's
// first guard is status sent/viewed and its write replaces the whole `response`
// sub-document, which is the evidence of what the vendor originally quoted.
// Branching it would put the destructive write one mistake away from this path.
router.post("/:token/counter-offer", counterOfferLimiter, ctrl.submitCounterOfferResponse);

/* ------------------------------------------------------------------ *
 * Completion. Same surface, job-scoped token (see models/JobToken.js).
 * ------------------------------------------------------------------ */

// image/* only. Video transcoding on an unauthenticated route is a materially
// larger abuse surface, and the authenticated intake path already covers video.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: completionCtrl.MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    return cb(new Error("Only image files are allowed"));
  },
});

// Same idiom as upload.routes.js: turn multer errors into clean 400s.
const handleUpload = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "Photo is too large (max 10MB)"
          : err.message || "Upload failed";
      return res.status(400).json({ success: false, message });
    }
    next();
  });
};

// readOnly widens the appointment-state gate to include in_review/disputed, so
// a vendor whose submission is being reviewed still sees its status rather than
// a dead link. Writes stay on the narrow gate.
router.get(
  "/:token/completion",
  completionReadLimiter,
  requireJobToken({ readOnly: true }),
  completionCtrl.getCompletion
);

// ORDER IS THE SECURITY PROPERTY: requireJobToken runs BEFORE multer, so an
// invalid or retired token is rejected without reading a single byte of the
// body. Reversing these two lines turns a leaked link into a way to stream
// 10MB into the process on every request.
router.post(
  "/:token/completion/photos",
  completionUploadLimiter,
  requireJobToken({ requireDraftCompletion: true }),
  handleUpload,
  completionCtrl.uploadCompletionPhoto
);

router.post(
  "/:token/completion/checkpoint",
  completionUploadLimiter,
  requireJobToken({ requireDraftCompletion: true }),
  completionCtrl.recordCheckpoint
);

router.post(
  "/:token/completion",
  completionSubmitLimiter,
  requireJobToken({ requireDraftCompletion: true }),
  completionCtrl.submitCompletion
);

// Status only. A forwarded job link must never authorize changes to the
// vendor's global payout account. Setup and updates require a hub session.
router.get(
  "/:token/payouts",
  completionReadLimiter,
  requireJobToken({ readOnly: true }),
  completionCtrl.getPayoutStatus
);

module.exports = router;
