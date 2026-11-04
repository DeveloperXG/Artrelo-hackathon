const { aiTriage, CATEGORIES, URGENCIES } = require("../services/ai/categorization.service");
const { determineFault } = require("../services/ai/faultDetermination.service");
const MaintenanceRequest = require("../models/MaintenanceRequest");
const env = require("../config/env");
const { issueTriageReceipt } = require("../services/ai/triageReceipt.service");
const Tenant = require('../models/Tenant');
const { getEligibility } = require('../services/request/creationEligibility.service');
const { evaluateSafetyGate } = require('../services/ai/safetyGate.service');
const { tenantUnitProblem } = require('../services/portfolio/deletionGuard.service');
const { findSimilar } = require('../services/request/similarRequests.service');

exports.postTriage = async (req, res) => {
  try {
    const { message, category, photos = [], requestId, context, intakeMode = 'routine' } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        success: false,
        message: "`message` is required (tenant description).",
      });
    }

    if (!['routine','safety'].includes(intakeMode)) return res.status(400).json({success:false,message:'Invalid intake mode.'});
    let tenant = null;
    // Authorization and admission happen before any paid provider request.
    if (req.user.role === 'tenant') {
      tenant = await Tenant.findById(req.user.id).populate('unit');
      if (!tenant) return res.status(404).json({success:false,message:'Tenant not found'});
      const problem = tenantUnitProblem(tenant);
      if (problem) return res.status(problem.status).json({success:false,...problem});
      if (requestId) return res.status(409).json({success:false,code:'use_intake_details',message:'Use the request’s missing-details or update action.'});
      const gate = await getEligibility(tenant);
      const hazard = evaluateSafetyGate({message,conversationHistory:context?.conversationHistory||[]}).triggered;
      if (!gate.creationEligibility.allowed && intakeMode !== 'safety' && !hazard) return res.status(429).json({success:false,code:'request_limit_reached',message:'Normal request creation is unavailable at your current limit.',data:gate});
    } else {
      if (!['landlord','property_manager','admin'].includes(req.user.role)) return res.status(403).json({success:false,message:'Access denied'});
      if (requestId && !await MaintenanceRequest.exists({_id:requestId,landlordId:req.user.id})) return res.status(404).json({success:false,message:'Request not found'});
    }
    const triageResult = await aiTriage({ message, category, photos, context });
    const triage = triageResult?.triage || triageResult;
    const incidentRecord = triageResult?.incidentRecord || null;
    const routingReadiness = triageResult?.routingReadiness || null;

    // Optionally persist on existing request
    if (requestId) {
      try {
        await MaintenanceRequest.findOneAndUpdate({ _id: requestId,
          ...(req.user.role === "landlord" ? { landlordId: req.user.id } : { tenantId: req.user.id }),
        }, {
          ai: triage,
          ...(incidentRecord ? { incidentRecord } : {}),
          ...(routingReadiness ? { routingReadiness } : {}),
        });
      } catch (_) {
        // Non-fatal
      }
    }

    // Backward compatible: data is still the triage object, with the structured
    // incident record and tenant/workflow envelope attached for newer clients.
    return res.json({
      success: true,
      data: triage,
      incidentRecord,
      tenantResponse: triageResult?.tenantResponse,
      workflow: triageResult?.workflow,
      troubleshooting: triageResult?.troubleshooting || null,
      routingReadiness,
      similarRequests: tenant ? await findSimilar({tenant,incoming:{...triage,issueDescription:message}}) : [],
      triageReceipt: issueTriageReceipt({ tenantId: req.user.id, triage, message,
        conversationHistory: context?.conversationHistory || [], photos }),
    });
  } catch (err) {
    console.error("[postTriage] error", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to triage request" });
  }
};

exports.postDetectFault = async (req, res) => {
  try {
    const { message, category, photos = [], context } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, message: "`message` is required" });
    }
    const result = await determineFault({ message, category, photos, context });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[postDetectFault] error", err);
    return res.status(500).json({ success: false, message: "Failed to detect fault" });
  }
};

exports.getMeta = (req, res) => {
  return res.json({
    success: true,
    data: {
      categories: CATEGORIES,
      urgencies: URGENCIES,
      provider: {
        openaiConfigured: Boolean(env.openai_api_key),
        model: env.ai_triage_provider === "meta" ? env.meta_model : env.openai_model,
        selected: env.ai_triage_provider,
        fallback: env.ai_triage_fallback_provider,
        metaConfigured: Boolean(env.meta_api_key),
      },
    },
  });
};
