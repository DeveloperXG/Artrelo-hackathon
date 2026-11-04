const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const isAuth = require("../middleware/auth.middleware").userAuth;
const { authorize } = require("../middleware/authorization.middleware");
const ctrl = require("../controllers/request.controller");

// The precheck opens a paid AI triage chat, and the daily / weekly request
// limits are only spent when a request is actually sent -- so without this a
// tenant could open chat after chat and never send one. Per tenant, loose
// enough that nobody using the portal normally ever meets it.
const precheckLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: () => Number.parseInt(process.env.PRECHECK_HOURLY_LIMIT, 10) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `precheck:${req.user.id}`,
  message: {
    success: false,
    code: "rate_limited",
    message: "You've started a lot of requests in the last hour. Please wait a little and try again.",
  },
});

// Tenant request operations
router.post("/precheck", isAuth, authorize("tenant"), precheckLimiter, ctrl.precheckRequest);
router.get("/quota", isAuth, authorize("tenant"), ctrl.getRequestQuota);
const submissionLimiter = rateLimit({windowMs:60*60*1000,limit:()=>Number.parseInt(process.env.PRECHECK_HOURLY_LIMIT,10)||20,
  keyGenerator:req=>`submit:${req.user.id}`,standardHeaders:true,legacyHeaders:false,
  message:{success:false,code:'rate_limited',message:'Please wait before sending another report. If there is immediate danger, contact emergency services or your property manager directly.'}});
router.post("/", isAuth, authorize("tenant"), submissionLimiter, ctrl.postNewRequest);
router.put('/:id/intake-details', isAuth, authorize('tenant'), require('../controllers/requestWorkflow.controller').putIntakeDetails);
router.post('/:id/updates', isAuth, authorize('tenant'), submissionLimiter, require('../controllers/requestWorkflow.controller').postUpdate);
router.get("/", isAuth, authorize("tenant"), ctrl.getAllRequests);
router.get("/:id", isAuth, ctrl.getRequest); // tenant OR landlord may view (access check inside)
router.delete("/:id", isAuth, authorize("tenant"), ctrl.deletePendingRequest);
router.put("/:id/cancel", isAuth, authorize("tenant"), ctrl.cancelRequest);
router.put("/:id/appeal", isAuth, authorize("tenant"), ctrl.appealRequest);
router.post("/:id/comments", isAuth, ctrl.postComment);

module.exports = router;
