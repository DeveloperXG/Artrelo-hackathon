const mongoose = require("mongoose");
const { getWorkRecord } = require("../services/completion/workRecord.service");
exports.getWorkRecord = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid request ID" });
  try {
    const data = await getWorkRecord({ requestId: req.params.id, landlordId: req.user.id });
    if (!data) return res.status(404).json({ success: false, message: "Request not found" });
    res.set("Cache-Control", "private, no-store");
    return res.json({ success: true, data });
  } catch (error) {
    console.error("[workRecord] read failed", error.message);
    return res.status(500).json({ success: false, message: "The work record could not be loaded" });
  }
};
