const assert = require("assert");

// Stub every data dependency the controller touches BEFORE requiring it, so the
// cached module instances the controller destructures are the stubbed ones.

// --- Tenant: returns a tenant with a unit ---
const Tenant = require("../../../models/Tenant");
const linkedTenant = {
  _id: "tenant1",
  landlord: "landlord1",
  firstName: "Test",
  lastName: "Tenant",
  unit: { _id: "unit1", propertyId: "prop1" },
};
let tenantRow = linkedTenant;
Tenant.findById = () => ({ populate: async () => tenantRow });

// --- MaintenanceRequest: control open-count, dedup, and capture creates ---
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
let openCount = 0;
let createdDoc = null;
MaintenanceRequest.countDocuments = async () => openCount; // used by the cap guardrail
MaintenanceRequest.find = () => ({ select: () => ({ lean: async () => [] }) }); // dedup query
MaintenanceRequest.create = async (doc) => {
  createdDoc = doc;
  return { ...doc, _id: "req1" };
};

// --- aiTriage: configurable urgency so we can simulate emergency vs not ---
const categorization = require("../../../services/ai/categorization.service");
let triageUrgency = "low";
let triageEntry = null;
categorization.aiTriage = async () => ({
  triage: {
    summary: "stub summary",
    access: { permissionToEnter: triageEntry },
    category: "Other",
    urgency: triageUrgency,
    severity: triageUrgency === "emergency" ? 5 : 1,
    emergencyServicesRecommended: triageUrgency === "emergency",
    suggestedResponsibility: "unknown",
    suggestedVendorType: null,
    followUpQuestions: [],
    safetyWarning: "",
    intakeStatus: "ready_to_submit",
    readyToSubmit: true,
    source: "stub",
  },
});

// --- AgentActionLog: capture logged actions ---
const AgentActionLog = require("../../../models/AgentActionLog");
let loggedActions = [];
AgentActionLog.create = async (entry) => {
  loggedActions.push(entry);
  return entry;
};

// --- Daily / weekly limits: a scripted ledger ---
const quotaService = require("../../../services/request/requestQuota.service");
let quotaAllowed = true;
let reserved = [];
let released = [];
let attached = [];
quotaService.reserveSlot = async ({ tenantId }) => {
  if (!quotaAllowed) {
    return { allowed: false, quota: { blocked: true, blockedBy: "daily", nextAvailableAt: new Date() } };
  }
  reserved.push(tenantId);
  return { allowed: true, slotId: `slot${reserved.length}` };
};
quotaService.releaseSlot = async (slotId) => {
  if (slotId) released.push(slotId);
};
quotaService.attachRequest = async (slotId, requestId) => {
  if (slotId) attached.push([slotId, requestId]);
};

// --- notifyUser: no-op ---
const notifyService = require("../../../services/notification/notify.service");
notifyService.notifyUser = () => {};

require("../../../services/request/initialRouting.service").processInitialRouting = async () => {};
// Admission is a separately integrated real Mongo transaction; this test isolates
// the controller's safety authority, response shaping and entry-consent handling.
const admission = require('../../../services/request/creationEligibility.service');
admission.getEligibility = async () => ({creationEligibility:{allowed:openCount<2&&quotaAllowed,reasons:openCount>=2?['open_cap']:quotaAllowed?[]:['daily_limit']}});
admission.replaySubmission = async () => null;
admission.createAdmittedRequest = async (payload, {exempt}) => {
  if (!exempt && openCount >= 2) throw Object.assign(new Error('Open cap reached'),{statusCode:429,code:'request_open_cap_reached'});
  if (!exempt && !quotaAllowed) throw Object.assign(new Error('Quota reached'),{statusCode:429,code:'request_quota_reached'});
  const request = await MaintenanceRequest.create(payload);
  return {request,replayed:false};
};
require('../../../services/notification/newRequestAlert.service').alertLandlordOfNewRequest = async () => {};
const ctrl = require("../../../controllers/request.controller");

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
};

const baseBody = {
  issueTitle: "Fan",
  issueDescription: "Bathroom fan rattles loudly",
  category: "Other",
  source: "form",
  runTriage: true,
};

const triagedLog = () => loggedActions.find((a) => a.actionType === "request_triaged");

const mismatchLog = () =>
  loggedActions.find((a) => a.actionType === "emergency_claim_unvalidated");

const run = async () => {
  let res;
  for (const scenario of [
    {claim:true, model:'low', expected:201, state:'needs_review'},
    {claim:false, model:'low', expected:429},
    {claim:false, model:'emergency', expected:429},
  ]) {
    triageUrgency=scenario.model;openCount=2;createdDoc=null;loggedActions=[];res=makeRes();
    await ctrl.postNewRequest({user:{id:'tenant1'},body:{...baseBody,emergencyOverride:scenario.claim}},res);
    assert.strictEqual(res.statusCode,scenario.expected);
    if(scenario.state) {assert.strictEqual(createdDoc.safetyAssessment.state,scenario.state);assert.strictEqual(createdDoc.urgency,'emergency');}
    assert.ok(!mismatchLog(), 'the model cannot label a tenant concern false');
  }
  // Client urgency alone is not safety authority. Explicit tenant reports are.
  triageUrgency='low';openCount=2;res=makeRes();
  await ctrl.postNewRequest({user:{id:'tenant1'},body:{...baseBody,runTriage:false,urgency:'emergency'}},res);
  assert.strictEqual(res.statusCode,429);
  res=makeRes();
  await ctrl.postNewRequest({user:{id:'tenant1'},body:{...baseBody,runTriage:false,intakeMode:'safety'}},res);
  assert.strictEqual(res.statusCode,201);assert.strictEqual(createdDoc.safetyAssessment.state,'needs_review');
  for (const row of [{...linkedTenant,status:'inactive',unit:null},{...linkedTenant,unit:null},
    {...linkedTenant,unit:{...linkedTenant.unit,archivedAt:new Date()}}]) {
    tenantRow=row;res=makeRes();await ctrl.postNewRequest({user:{id:'tenant1'},body:baseBody},res);
    assert.strictEqual(res.statusCode,409);assert.strictEqual(res.body.code,'tenant_no_unit');
  }
  tenantRow=linkedTenant;openCount=0;quotaAllowed=false;res=makeRes();
  await ctrl.postNewRequest({user:{id:'tenant1'},body:baseBody},res);assert.strictEqual(res.statusCode,429);
  quotaAllowed=true;
  const env = require("../../../config/env");
  env.jwt_secret = "unit-only-consent-secret";
  const { issueTriageReceipt, hasRoutingAuthority } = require("../../../services/ai/triageReceipt.service");
  const { buildRevealedDetails } = require("../../../services/vendor/vendorBrief.service");
  // Submission chooses explicit request consent, then verified triage, then null.
  for (const scenario of [
    { server: null, explicit: undefined, expected: null },
    { server: false, explicit: undefined, expected: false },
    { server: true, explicit: false, expected: false },
    { server: false, explicit: true, expected: true },
  ]) {
    triageEntry = scenario.server;
    res = makeRes();
    await ctrl.postNewRequest({ user: { id: "tenant1" }, body: { ...baseBody, accessPermission: scenario.explicit } }, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(createdDoc.accessPermission, scenario.expected);
    assert.strictEqual(createdDoc.incidentRecord.access.permissionToEnter, scenario.expected);
    assert.strictEqual(createdDoc.ai.access.permissionToEnter, scenario.expected);
    assert.strictEqual(buildRevealedDetails({ request: createdDoc }).access.permissionToEnter, scenario.expected);
  }
  for (const verified of [false, true]) {
    const message = "Bathroom fan rattles. Any day, anytime.";
    const history = [{ role: "user", content: message }];
    const snapshot = { summary: "Fan rattles.", category: "Electrical", urgency: "low", severity: 1,
      readyToSubmit: true, access: { permissionToEnter: false, pets: false, preferredTimes: ["Any day, anytime"] },
      intakeState: { version: 1, askedIds: ["entryPermission"], answers: [{ topicId: "entryPermission", state: "answered" }], selectedQuestion: null, followUpCount: 1, needsManagerReview: true } };
    const receipt = verified ? issueTriageReceipt({ tenantId: "tenant1", triage: snapshot, conversationHistory: history }) : undefined;
    res = makeRes();
    await ctrl.postNewRequest({ user: { id: "tenant1" }, body: { ...baseBody, source: "chat", runTriage: false,
      issueDescription: message, conversationHistory: history, triageSnapshot: snapshot, triageReceipt: receipt } }, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(createdDoc.accessPermission, verified ? false : null);
    assert.strictEqual(buildRevealedDetails({ request: createdDoc }).access.permissionToEnter, verified ? false : null);
    if (verified) assert.ok(hasRoutingAuthority(new MaintenanceRequest(createdDoc).toObject()), "new state preserves signed routing authority after database casting");
  }
  // The actual consent parser's restrictions survive receipt verification,
  // request persistence, and the contractor-facing projection.
  for (const [answer, expected] of [
    ["You can enter when I am home.", false],
    ["You can enter only after I approve the visit.", null],
  ]) {
    const history = [{ role: "user", content: "Bathroom fan rattles." },
      { role: "ai", content: "Is it okay for a technician to enter if you're not home?" },
      { role: "user", content: answer }];
    const description = history.filter((turn) => turn.role === "user").map((turn) => turn.content).join("\n");
    const snapshot = categorization.normalizeTriageOutput({ summary: "Fan rattles.", category: "Electrical",
      urgency: "low", readyToSubmit: true, access: { permissionToEnter: true } },
    answer, "Electrical", { conversationHistory: history });
    assert.strictEqual(snapshot.access.permissionToEnter, expected);
    const receipt = issueTriageReceipt({ tenantId: "tenant1", triage: snapshot, conversationHistory: history });
    res = makeRes();
    await ctrl.postNewRequest({ user: { id: "tenant1" }, body: { ...baseBody, source: "chat", runTriage: false,
      issueDescription: description, conversationHistory: history, triageSnapshot: snapshot, triageReceipt: receipt } }, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(createdDoc.accessPermission, expected);
    assert.strictEqual(createdDoc.incidentRecord.access.permissionToEnter, expected);
    assert.strictEqual(buildRevealedDetails({ request: createdDoc }).access.permissionToEnter, expected);
  }
  // A hypothetical fire concern is not an emergency on request creation either.
  openCount = 2;
  res = makeRes();
  await ctrl.postNewRequest({ user: { id: "tenant1" }, body: { ...baseBody, runTriage: false,
    issueDescription: "The breaker keeps tripping. This could be a fire hazard, but there is no smoke or sparks.", emergencyOverride: true } }, res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(createdDoc.safetyAssessment.state, 'needs_review');
  console.log("request.controller postNewRequest emergency-validation and consent tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
