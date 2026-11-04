const express = require("express");
const router = express.Router(); // important for :userId
const isAuth = require("../middleware/auth.middleware").userAuth;
const isTenantNotificationsEnabled = require("../middleware/validation.middleware").checkTenantNotificationsEnabled;
const notificationController = require("../controllers/notification.controller");

//-- Notification route allows tenants to getNotifications, getNotification, markRead, deleteOne, deleteAll, markAllRead

router.get("/", isAuth, isTenantNotificationsEnabled,  notificationController.getNotifications);

router.get("/:id", isAuth, isTenantNotificationsEnabled, notificationController.getNotification);

router.put("/", isAuth, isTenantNotificationsEnabled, notificationController.markAllRead);

router.put("/:id", isAuth, isTenantNotificationsEnabled, notificationController.markRead);

router.delete("/", isAuth, isTenantNotificationsEnabled, notificationController.deleteNotifications);

router.delete("/:id", isAuth, isTenantNotificationsEnabled, notificationController.deleteNotification);


module.exports = router;
