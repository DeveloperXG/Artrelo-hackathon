const assert = require("assert");
const { evaluateSafetyGate } = require("../../../services/ai/safetyGate.service");

const trips = (message, conversationHistory = []) =>
  evaluateSafetyGate({ message, conversationHistory });

// --- Positive hazard detection ---
const gas = trips("I think I smell gas in the kitchen");
assert.strictEqual(gas.triggered, true);
assert.strictEqual(gas.riskType, "gas");
assert.strictEqual(gas.lifeSafetyConcern, true);
assert.strictEqual(gas.action, "emergency_escalation");
assert.strictEqual(gas.notifyManager, true);
assert.strictEqual(gas.suppressTroubleshooting, true);
assert.ok(/gas/i.test(gas.guidance));

const sparking = trips("the outlet in my bedroom is sparking");
assert.strictEqual(sparking.triggered, true);
assert.strictEqual(sparking.riskType, "electrical");

const exposed = trips("there are exposed wires hanging from the ceiling");
assert.strictEqual(exposed.triggered, true);
assert.strictEqual(exposed.riskType, "electrical");

const sewage = trips("raw sewage is backing up into the bathtub");
assert.strictEqual(sewage.triggered, true);
assert.strictEqual(sewage.riskType, "sewage");
assert.strictEqual(sewage.activeDamage, true);
assert.strictEqual(sewage.lifeSafetyConcern, false);

const co = trips("the carbon monoxide alarm is going off");
assert.strictEqual(co.triggered, true);
assert.strictEqual(co.riskType, "carbon_monoxide");

const smokeFilling = trips("smoke is filling the living room");
assert.strictEqual(smokeFilling.triggered, true);
assert.strictEqual(smokeFilling.riskType, "smoke");

const injury = trips("my roommate got electrocuted and is bleeding");
assert.strictEqual(injury.triggered, true);
// injury is the most severe, but electrical may also match — primary is the first
// (most serious) rule in order; both gas/fire/co/smoke/exposed/spark precede it.
assert.ok(["injury", "electrical"].includes(injury.riskType));

const noHeatCold = trips("there is no heat and it is freezing outside");
assert.strictEqual(noHeatCold.triggered, true);
assert.strictEqual(noHeatCold.riskType, "other");

// --- Negative cases (must NOT trip) ---
assert.strictEqual(trips("my dishwasher won't drain").triggered, false);
assert.strictEqual(trips("the kitchen faucet drips slowly").triggered, false);
// A chirping smoke detector (low battery) is not an emergency.
assert.strictEqual(trips("my smoke detector keeps chirping every minute").triggered, false);
// "no heat" without a cold signal is urgent but not gated as an emergency here.
assert.strictEqual(trips("the heater isn't working").triggered, false);
// A gas stove mention without a leak/smell should not trip.
assert.strictEqual(trips("my gas stove burner won't light").triggered, false);

// --- Conversation history is scanned (hazard mentioned earlier) ---
const fromHistory = trips("it's in the kitchen", [
  { role: "user", content: "I smell gas" },
  { role: "ai", content: "Where is it?" },
]);
assert.strictEqual(fromHistory.triggered, true);
assert.strictEqual(fromHistory.riskType, "gas");

// The assistant's own words must NOT trip the gate.
const assistantOnly = trips("the sink is slow", [
  { role: "ai", content: "Is there any smoke or a gas smell?" },
]);
assert.strictEqual(assistantOnly.triggered, false);

// Independent assertions must not lend their historical/negative context to a
// current hazard, and every occurrence must be examined rather than just the first.
for (const [message, code] of [
  ["No spreading water and sparks are coming from the outlet now.", "sparking_outlet"],
  ["No spreading water, sparks are coming from the outlet now.", "sparking_outlet"],
  ["I smell gas and I previously reported the broken sink.", "gas_leak"],
  ["I previously reported the broken sink and I smell gas.", "gas_leak"],
  ["No sparks earlier, and now sparks are coming out of the outlet.", "sparking_outlet"],
  ["No sparks earlier, sparks are coming out of the outlet now.", "sparking_outlet"],
  ["There was no gas smell before and I smell gas now.", "gas_leak"],
  ["There was no smoke yesterday and there is a fire in the kitchen.", "fire"],
]) {
  const result = trips(message);
  assert.ok(result.hazards.some((hazard) => hazard.code === code), message);
  assert.strictEqual(result.suppressTroubleshooting, true, message);
}
for (const message of [
  "The kitchen sink faucet has been dripping since yesterday. Sink still works and there is no spreading water, smoke or sparks.",
  "No spreading water, smoke or sparks.",
  "No smoke, sparks or gas smell.",
  "No smoke and no sparks or gas smell.",
  "We had a gas leak last year and I previously reported the broken sink.",
  "I smelled gas last week but the utility checked and cleared it.",
  "What if the outlet sparks?",
]) {
  assert.strictEqual(trips(message).triggered, false, message);
}

console.log("safetyGate.service tests passed");
