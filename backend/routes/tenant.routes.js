const express = require("express");
const profileRoutes = require("./profile.routes");
const requestRoutes = require("./request.routes");
const notificationRoutes = require("./tenantNotification.routes");
const appointmentRoutes = require("./tenantAppointment.routes");
const requestCtrl = require("../controllers/request.controller");
const moveOutCtrl = require("../controllers/tenantMoveOut.controller");
const router = express.Router();

router.use("/profile", profileRoutes);
router.use("/requests", requestRoutes);
router.use("/notifications", notificationRoutes);
router.use("/appointments", appointmentRoutes);
// Sidebar badge. Counts only — called on every navigation, so it stays cheap.
router.get("/badge-counts", requestCtrl.getTenantBadgeCounts);
// Move-out requested by the landlord (they are retiring the unit).
router.get("/move-out", moveOutCtrl.getMoveOutStatus);
router.post("/move-out/confirm", moveOutCtrl.confirmMoveOut);

module.exports = router;
