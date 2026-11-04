const activity = require("../services/request/irisActivity.service");
const handle = (method) => async (req, res) => {
  // Also enforce role here so direct invocation cannot bypass route middleware.
  if (!["landlord", "property_manager", "admin"].includes(req.user?.role)) return res.status(403).json({ success: false, message: "Access denied" });
  try {
    const data = method === "list" ? await activity.list(req.user.id, req.query) : await activity.detail(req.user.id, req.params.id, req.query);
    return res.json({ success: true, data });
  } catch (error) {
    const status = [400, 404].includes(error.status) ? error.status : 500;
    return res.status(status).json({ success: false, message: status === 500 ? "Failed to load Iris activity" : error.message });
  }
};
exports.list = handle("list");
exports.detail = handle("detail");
