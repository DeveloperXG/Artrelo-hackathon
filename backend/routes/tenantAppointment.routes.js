const express = require("express");
const router = express.Router();
const requestCtrl = require("../controllers/request.controller");

// Mounted under /tenants, which already applies userAuth + the tenant role
// check in app.js. Handlers scope every query by req.user.id.
router.get("/", requestCtrl.listTenantAppointments);
router.put("/:id/confirm", requestCtrl.confirmTenantAppointment);
// "Was this actually fixed?" — the tenant's verdict once a vendor submits proof.
router.put("/:id/verify", requestCtrl.verifyTenantJobCompletion);
// "The vendor never came." Goes to the manager; re-routes nothing by itself.
router.post("/:id/report-no-show", requestCtrl.reportTenantNoShow);

module.exports = router;
