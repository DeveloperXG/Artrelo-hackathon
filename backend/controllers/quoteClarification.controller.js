const service = require("../services/quotes/clarification.service");
function rejected(res, error) {
  const status = [400, 404, 409, 410].includes(error.statusCode || error.status) ? error.statusCode || error.status : 500;
  return res.status(status).json({ success: false, code: status === 500 ? "clarification_unavailable" : error.code,
    message: status === 400 ? "Check the answers and itemized amounts." : status === 410 ? "This clarification link expired. The landlord must review the costs." :
      "This clarification is unavailable or has changed." });
}
exports.get = async (req, res) => { try { return res.json({ success: true, data: await service.getClarification(req.params.token) }); }
catch (error) { return rejected(res, error); } };
exports.submit = async (req, res) => { try { return res.json({ success: true, data: await service.submitClarification(req.params.token, req.body) }); }
catch (error) { return rejected(res, error); } };
