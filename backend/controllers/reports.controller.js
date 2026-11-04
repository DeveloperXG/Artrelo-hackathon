// GET /landlords/reports?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// The Reports page. Mounted under /landlords (userAuth + landlord role), and
// every query is scoped by req.user.id. The rules live in
// services/reports/landlordReports.service.js.

const { parseRange, buildLandlordReport, ReportRangeError } = require("../services/reports/landlordReports.service");

exports.getReport = async (req, res) => {
  try {
    const range = parseRange(req.query);
    const data = await buildLandlordReport(req.user.id, range);
    return res.json({ success: true, data });
  } catch (err) {
    if (err instanceof ReportRangeError) {
      // `field` lets the date picker show this beside the input, not in a toast.
      return res.status(400).json({ success: false, field: err.field, message: err.message });
    }
    console.error("[getReport] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
