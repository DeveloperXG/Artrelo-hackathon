const assert = require("assert");
const env = require("../../../config/env");
env.jwt_secret = "unit-only-triage-receipt-secret";
const { issueTriageReceipt, verifyTriageReceipt, routingDigest, hasRoutingAuthority } = require("../../../services/ai/triageReceipt.service");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const now = Date.now();
const history = [{ role: "user", content: "Bathroom fan rattles" }, { role: "ai", content: "Since when?" }, { role: "user", content: "Since yesterday" }];
const triage = { urgency: "low", severity: 1, readyToSubmit: true, summary: "A rattling fan" };
const receipt = issueTriageReceipt({ tenantId: "tenant-a", triage, message: "Since yesterday", conversationHistory: history, photos: ["https://test/photo"], now });
const args = { receipt, tenantId: "tenant-a", triage, issueDescription: "Bathroom fan rattles\nSince yesterday", conversationHistory: history, photos: ["https://test/photo"], now };
assert.ok(verifyTriageReceipt(args));
assert.ok(verifyTriageReceipt({ ...args, conversationHistory: [...history, { role: "ai", content: "You can submit" }] }), "the final assistant reply is not tenant input");
assert.ok(!verifyTriageReceipt({ ...args, tenantId: "tenant-b" }));
assert.ok(!verifyTriageReceipt({ ...args, now: now + 7201_000 }));
assert.ok(!verifyTriageReceipt({ ...args, triage: { ...triage, severity: 2 } }));
assert.ok(!verifyTriageReceipt({ ...args, issueDescription: "Water is flooding" }));
assert.ok(!verifyTriageReceipt({ ...args, photos: [] }));
assert.ok(!verifyTriageReceipt({ ...args, receipt: receipt.slice(0, -6) + "abcdef" }));
assert.ok(!verifyTriageReceipt({ ...args, receipt: null }));
const payload = JSON.parse(Buffer.from(receipt.split(".")[1], "base64url"));
assert.ok(!JSON.stringify(payload).includes("fan"), "tokens carry digests, not intake text");
const longHistory = Array.from({ length: 35 }, (_, i) => ({ role: "user", content: `detail ${i}` }));
const longReceipt = issueTriageReceipt({ tenantId: "tenant-a", triage, conversationHistory: longHistory, now });
assert.ok(verifyTriageReceipt({ receipt: longReceipt, tenantId: "tenant-a", triage, conversationHistory: longHistory, issueDescription: longHistory.map((m) => m.content).join("\n"), now }));
assert.ok(!verifyTriageReceipt({ receipt: longReceipt, tenantId: "tenant-a", triage, conversationHistory: longHistory.slice(-20), issueDescription: longHistory.map((m) => m.content).join("\n"), now }));

const request = new MaintenanceRequest({ issueTitle: "Fan", issueDescription: "Rattles", category: "Electrical", urgency: "low", responsibility: "landlord", vendorTypeNeeded: "Electrical", ai: { urgency: "low", severity: 1 },
  incidentRecord: { trade: "Electrical", severity: 1, responsibility: "landlord", confidence: { overall: 0.9 } },
  routingReadiness: { state: "ready_to_route", blocking: false } });
request.routingAuthority = { digest: routingDigest(request) };
assert.ok(hasRoutingAuthority(request.toObject()), "Mongoose defaults/casting preserve the proof");
request.ai.severity = 4;
assert.ok(!hasRoutingAuthority(request), "later triage changes invalidate prior authority");
console.log("triageReceipt tests passed");
