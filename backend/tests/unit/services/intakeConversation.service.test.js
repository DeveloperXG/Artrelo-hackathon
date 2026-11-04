const assert = require("assert");
let output = {};
let calls = 0;
const provider = require("../../../services/ai/triageProvider.service");
provider.runTriage = async (options) => {
  calls++;
  assert.strictEqual(options.schema.strict, true);
  assert.ok(options.messages.some((m) => m.content.includes("FIRST extract ALL")));
  return { parsed: output, telemetry: { provider: "openai", outcome: "success", attempts: [] } };
};
const env = require("../../../config/env");
env.jwt_secret = "unit-only-intake-secret";
const { aiTriage, normalizeTriageOutput, deterministicTriage, detectIssueResolved, buildTriageResult } = require("../../../services/ai/categorization.service");
const { explicitEntryConsent } = require("../../../services/ai/intakeState.service");
const { evaluateSafetyGate } = require("../../../services/ai/safetyGate.service");
const { verifyTriageReceipt } = require("../../../services/ai/triageReceipt.service");
const Request = require("../../../models/MaintenanceRequest");
const fixtures = require("../../fixtures/triageConversations");
const basic = { summary: "Maintenance issue", category: "Plumbing", urgency: "medium", followUpQuestions: [] };
const run = async () => {
  for (const fixture of fixtures) {
    output = { ...basic, ...fixture.facts, category: fixture.category,
      acknowledgment: "Those details help me understand what's happening.",
      questionCandidates: [{ topicId: "availability", question: "When are you available?" },
        { topicId: "entryPermission", question: "Is it okay for a technician to enter if you're not home?" }] };
    const history = [{ role: "user", content: fixture.message }];
    const before = calls;
    const result = await aiTriage({ message: fixture.message, category: fixture.category, context: { conversationHistory: history } });
    assert.strictEqual(calls - before, 1, "one provider call per turn");
    const triage = result.triage;
    assert.strictEqual(triage.source, "openai", "provider path must not silently fall back");
    assert.strictEqual(triage.intakeState.selectedQuestion.topicId, "entryPermission", fixture.category);
    assert.strictEqual(triage.access.permissionToEnter, null, "availability never grants entry");
    assert.match(triage.additionalNotes, fixture.notes);
    assert.notStrictEqual(triage.urgency, "emergency", fixture.category);
    if (fixture.category === "Electrical") assert.ok(!result.troubleshooting.allowedSteps.some((s) => /reset|back ON/i.test(s)));
    const reply = result.tenantResponse.message;
    assert.ok(!reply.includes(output.acknowledgment), 'legacy acknowledgment is never rendered');
    assert.strictEqual(triage.acknowledgment, undefined);
    history.push({ role: "ai", content: reply }, { role: "user", content: "No, I need to be home. There are no pets." });
    output = { ...basic, category: fixture.category, impact: "", location: { room: "", area: "" }, timeline: { started: "", trend: "Unknown" }, attemptedFixes: [], access: { permissionToEnter: null, pets: false, preferredTimes: [] }, additionalNotes: "Please call before arriving." };
    const updated = (await aiTriage({ message: history.at(-1).content, category: fixture.category, context: { previousTriage: triage, conversationHistory: history } })).triage;
    assert.strictEqual(updated.impact, triage.impact);
    assert.deepStrictEqual(updated.location, triage.location);
    assert.deepStrictEqual(updated.timeline, triage.timeline);
    assert.deepStrictEqual(updated.attemptedFixes, triage.attemptedFixes);
    assert.deepStrictEqual(updated.access.preferredTimes, triage.access.preferredTimes);
    assert.strictEqual(updated.access.permissionToEnter, false);
    assert.strictEqual(updated.access.pets, false);
    assert.match(updated.additionalNotes, fixture.notes);
    assert.match(updated.additionalNotes, /call before/);
  }
  for (const message of ["There is no smoke or sparks.", "I don't smell gas.", "This could be a fire hazard.", "We had a gas leak last year.", "What if the outlet sparks?", "The CO detector needs a new battery.", "There is no flooding, just a drip.", "The fire extinguisher needs replacing.", "The sparkling water fridge is noisy.", "I am concerned about the injury risk."]) {
    assert.strictEqual(evaluateSafetyGate({ message }).triggered, false, message);
    assert.notStrictEqual(deterministicTriage({ message }).urgency, "emergency", message);
  }
  for (const message of ["I suspect a gas leak.", "There are sparks coming from the outlet.", "No smoke, but I smell gas.", "No heat. It is freezing outside.", "There is no power and I smell gas.", "I'm not sure if I smell gas.", "There is no water and the outlet is sparking."]) {
    assert.strictEqual(evaluateSafetyGate({ message }).triggered, true, message);
  }
  for (const message of ["The reset worked for a few minutes, then the breaker tripped again.", "I fixed it yesterday but it is leaking again.", "The light works now but the outlet is still broken.", "It stopped leaking temporarily.", "The reset worked briefly but power is out again.", "I don't need a repair because I am moving out."]) {
    assert.strictEqual(detectIssueResolved(message), false, message);
  }
  assert.strictEqual(detectIssueResolved("The reset worked and the outlet is working now."), true);
  assert.strictEqual(detectIssueResolved("The fan is working now."), true);
  assert.strictEqual(detectIssueResolved("The reset worked, but it trips every time I use the outlet."), false);
  assert.strictEqual(detectIssueResolved("It stopped leaking and works again."), true);
  assert.strictEqual(evaluateSafetyGate({ message: "I smelled gas last week but the utility checked and cleared it." }).triggered, false);
  assert.strictEqual(evaluateSafetyGate({ message: "I smelled gas yesterday and still smell it now." }).triggered, true);
  assert.strictEqual(explicitEntryConsent("Any day, anytime"), null);
  assert.strictEqual(explicitEntryConsent("Entry is only allowed when I am home."), false);
  assert.strictEqual(explicitEntryConsent("It is not okay to enter."), false);
  assert.strictEqual(explicitEntryConsent("I can't say if you can enter."), null);
  assert.strictEqual(explicitEntryConsent("Maybe you can enter, I haven't decided."), null);
  assert.strictEqual(explicitEntryConsent("Yes", [{ role: "ai", content: "What times work, and can the technician enter?" }]), null);
  assert.strictEqual(explicitEntryConsent("Yes", [{ role: "ai", content: "Can the technician enter if you are out?" }]), true);
  assert.strictEqual(explicitEntryConsent("No", [{ role: "ai", content: "Can the technician enter if you are out?" }]), false);

  const entryQuestion = "Is it okay for a technician to enter if you're not home?";
  const entryHistory = [{ role: "ai", content: entryQuestion }];
  for (const message of [
    "You can enter when I am home.",
    "You can enter if I am home.",
    "You may enter while I'm here.",
    "Yes, but only when we are home.",
  ]) {
    assert.strictEqual(explicitEntryConsent(message, entryHistory), false, message);
    const normalized = normalizeTriageOutput({ ...basic, access: { permissionToEnter: true } },
      message, "Plumbing", { conversationHistory: entryHistory });
    assert.strictEqual(normalized.access.permissionToEnter, false, "even an affirmative model value cannot remove a presence condition");
  }
  for (const message of [
    "You can enter only after I approve the visit.",
    "Yes, but only if my landlord approves.",
    "You may enter once I confirm the visit.",
  ]) {
    assert.strictEqual(explicitEntryConsent(message, entryHistory), null, message);
  }
  assert.strictEqual(explicitEntryConsent("Yes, you may enter if I am not home.", entryHistory), true);
  assert.strictEqual(explicitEntryConsent("I do.", entryHistory), true);
  assert.strictEqual(explicitEntryConsent("I do.", [{ role: "ai", content: "Do you have pets?" }]), null);
  assert.strictEqual(explicitEntryConsent("You can enter when I am home.", [
    ...entryHistory, { role: "user", content: "Yes" }, { role: "ai", content: "Anything else?" },
  ]), false, "a presence condition overrides an earlier grant");

  for (const [topicId, question] of [
    ["entryPermission", entryQuestion],
    ["availability", "Do weekday afternoons work for a visit?"],
    ["pets", "Are there any pets the technician should know about?"],
  ]) {
    for (const message of ["That's fine.", "It's okay.", "That worked for me.", "It's working now."]) {
      const previousTriage = { ...basic, ...fixtures[0].facts,
        intakeState: { selectedQuestion: { topicId }, askedIds: [topicId], followUpCount: 1, answers: [] } };
      const conversationHistory = [{ role: "user", content: fixtures[0].message },
        { role: "ai", content: question }, { role: "user", content: message }];
      const result = buildTriageResult(normalizeTriageOutput({ ...basic, ...fixtures[0].facts },
        message, "Plumbing", { previousTriage, conversationHistory }));
      assert.strictEqual(result.triage.resolved, false, `${topicId}: ${message}`);
      assert.notStrictEqual(result.tenantResponse.nextAction, "issue_resolved");
      assert.notStrictEqual(result.workflow.actionType, "resolved_closed");
    }
  }
  for (const message of ["That's fine.", "It's okay now.", "All good.", "The reset worked and then the outlets stopped again."]) {
    assert.strictEqual(detectIssueResolved(message), false, message);
  }
  const accessContext = { previousTriage: { intakeState: { selectedQuestion: { topicId: "entryPermission" } } } };
  assert.strictEqual(detectIssueResolved("Actually, the sink is working now after the reset.", accessContext), true);
  assert.strictEqual(detectIssueResolved("It's fixed now.", accessContext), true);
  for (const message of ["I smell gas and I previously reported the broken sink.",
    "No sparks earlier, and now sparks are coming out of the outlet."]) {
    assert.strictEqual(deterministicTriage({ message }).urgency, "emergency", message);
  }

  let previous = normalizeTriageOutput({ ...basic, questionCandidates: [{ topicId: "timeline", question: "When did this start?" }] }, "Sink issue");
  for (const answer of ["I don't know", "I'd rather not say"]) {
    const history = [{ role: "user", content: "Sink issue" }, { role: "ai", content: "When did this start?" }, { role: "user", content: answer }];
    const next = normalizeTriageOutput({ ...basic, questionCandidates: [{ topicId: "timeline", question: "How long has this happened?" }] }, answer, "Plumbing", { previousTriage: previous, conversationHistory: history });
    assert.ok(!next.followUpQuestions.some((q) => /when|how long/i.test(q)));
    assert.strictEqual(next.intakeState.answers.find((a) => a.topicId === "timeline").state, answer.includes("know") ? "unknown" : "declined");
  }
  const established = { ...basic, readyToSubmit: true, summary: "Locked summary.", additionalNotes: "Can make an earlier visit work.", location: { room: "Kitchen" }, safety: { activeDamage: true }, access: { permissionToEnter: false, pets: false, preferredTimes: ["Weekdays"] }, attemptedFixes: ["Tightened fitting"] };
  const corrected = normalizeTriageOutput({ ...basic, location: { room: "Bathroom" }, safety: { activeDamage: false }, access: { preferredTimes: ["Evenings"] }, correctedFields: ["access.preferredTimes", "attemptedFixes"], attemptedFixes: [], additionalNotes: "Correction: bathroom, evenings only." }, "Actually it is the bathroom, evenings only.", "Plumbing", { previousTriage: established });
  assert.strictEqual(corrected.summary, established.summary);
  assert.strictEqual(corrected.location.room, "Bathroom");
  assert.strictEqual(corrected.safety.activeDamage, false);
  assert.strictEqual(corrected.access.permissionToEnter, false);
  assert.strictEqual(corrected.access.pets, false);
  assert.deepStrictEqual(corrected.access.preferredTimes, ["Evenings"]);
  assert.deepStrictEqual(corrected.attemptedFixes, []);
  assert.match(corrected.additionalNotes, /earlier visit/);
  const notesCorrection = normalizeTriageOutput({ ...basic, additionalNotes: "Correction: weekday evenings after 6, call before arriving." }, "After 6, please.", "Plumbing", { previousTriage: { ...basic, additionalNotes: "Weekday evenings after 5, call before arriving." } });
  assert.match(notesCorrection.additionalNotes, /after 5/);
  assert.match(notesCorrection.additionalNotes, /after 6/);
  const withdrawn = normalizeTriageOutput({ ...basic, location: { room: "" }, correctedFields: ["location.room"], topicAnswers: [{ topicId: "location", state: "unknown" }] }, "Actually not the kitchen. I don't know where it is.", "Plumbing", { previousTriage: established });
  assert.strictEqual(withdrawn.location.room, "", "an explicit withdrawal clears only the corrected fact");
  assert.strictEqual(withdrawn.access.permissionToEnter, false);
  const legacyBundle = normalizeTriageOutput({ ...fixtures[4].facts, category: "Pest", urgency: "medium" }, "Any day, anytime", "Pest", { conversationHistory: [{ role: "ai", content: "What times work, and can a technician enter?" }, { role: "user", content: "Any day, anytime" }] });
  assert.strictEqual(legacyBundle.intakeState.selectedQuestion.topicId, "entryPermission");
  assert.strictEqual(legacyBundle.access.permissionToEnter, null);
  const uncertain = normalizeTriageOutput({ ...basic, timeline: { trend: "Worsening" } }, "It is possibly worsening.");
  assert.strictEqual(uncertain.timeline.trend, "Unknown");
  assert.match(uncertain.additionalNotes, /possibly/);
  for (let turn = 0; turn < 6 && !previous.readyToSubmit; turn++) {
    previous = normalizeTriageOutput(basic, "I'm not sure", "Plumbing", { previousTriage: previous });
  }
  assert.strictEqual(previous.readyToSubmit, true);
  assert.ok(previous.intakeState.followUpCount <= 6);
  assert.strictEqual(buildTriageResult(previous).routingReadiness.state, "needs_manager_review");
  const completeCore = { ...basic, impact: "Sink unusable", location: { room: "Kitchen" }, timeline: { started: "Monday" }, attemptedFixes: ["None attempted"] };
  const cappedOptional = normalizeTriageOutput(completeCore, "Nothing else", "Plumbing", { previousTriage: { intakeState: { followUpCount: 4 } } });
  assert.strictEqual(cappedOptional.readyToSubmit, true, "optional access questions stop at four follow-ups");
  let essential = normalizeTriageOutput({ ...completeCore, questionCandidates: [{ topicId: "extent", question: "Are other drains affected too?" }] }, "Not sure", "Plumbing", { previousTriage: { intakeState: { followUpCount: 4 } } });
  assert.strictEqual(essential.intakeState.followUpCount, 5);
  assert.strictEqual(essential.intakeState.selectedQuestion.topicId, "extent");
  essential = normalizeTriageOutput({ ...completeCore, questionCandidates: [{ topicId: "structuralChange", question: "Has the nearby wall changed?" }] }, "I don't know", "Plumbing", { previousTriage: essential });
  assert.strictEqual(essential.intakeState.followUpCount, 6);
  essential = normalizeTriageOutput(completeCore, "I don't know", "Plumbing", { previousTriage: essential });
  assert.strictEqual(essential.readyToSubmit, true, "essential questions stop after six follow-ups");
  assert.strictEqual(essential.intakeState.needsManagerReview, true);

  const saved = new Request({ issueTitle: "Sink", issueDescription: "Issue", ai: corrected });
  const persisted = saved.toObject().ai;
  assert.deepStrictEqual(persisted.intakeState, corrected.intakeState);
  assert.strictEqual(persisted.location.room, "Bathroom");
  assert.strictEqual(persisted.access.permissionToEnter, false);
  assert.strictEqual(new Request().accessPermission, null);
  const old = new Request({ ai: { summary: "Old record" } });
  assert.deepStrictEqual(old.ai.intakeState.askedIds.toObject(), []);

  // Exercise the actual controller response and its signed receipt together.
  output = { ...basic, ...fixtures[0].facts };
  require('../../../models/Tenant').findById=()=>({populate:async()=>({_id:'tenant-a',landlord:'landlord-a',unit:{_id:'unit-a',propertyId:'property-a'}})});
  require('../../../services/request/creationEligibility.service').getEligibility=async()=>({creationEligibility:{allowed:true}});
  require('../../../services/request/similarRequests.service').findSimilar=async()=>[];
  const ctrl = require("../../../controllers/ai.controller");
  let response;
  const history = [{ role: "user", content: fixtures[0].message }];
  await ctrl.postTriage({ user: { id: "tenant-a", role: "tenant" }, body: { message: fixtures[0].message, context: { conversationHistory: history } } }, { json: (body) => { response = body; }, status() { return this; } });
  assert.strictEqual(response.data.category, "Plumbing");
  assert.ok(!response.data.triage, "data remains the triage object");
  assert.ok(response.tenantResponse.message);
  assert.ok(response.workflow);
  assert.ok(verifyTriageReceipt({ receipt: response.triageReceipt, tenantId: "tenant-a", triage: response.data, conversationHistory: history, issueDescription: fixtures[0].message }));
  assert.ok(!verifyTriageReceipt({ receipt: response.triageReceipt, tenantId: "tenant-a", triage: { ...response.data, access: { permissionToEnter: true } }, conversationHistory: history, issueDescription: fixtures[0].message }));
  console.log("intake conversation regression tests passed");
};
run().catch((err) => { console.error(err); process.exitCode = 1; });
