const Tenant = require("../models/Tenant");

exports.checkTenantNotificationsEnabled = async (req, res, next) => {
  try {
    // For MVP: notifications enabled by default unless tenant opted out
    if (!req.user || !req.user.id) return next();
    const tenant = await Tenant.findById(req.user.id).select("notificationPreferences");
    if (tenant && tenant.notificationPreferences && tenant.notificationPreferences.push === false) {
      // honor opt-out but allow read still
    }
    next();
  } catch (err) {
    console.error("[checkTenantNotificationsEnabled]", err);
    next();
  }
};
