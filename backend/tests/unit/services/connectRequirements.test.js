const assert = require("assert");
const { summarizeRequirements, normalizeBusinessWebsite } = require("../../../services/ledger/connectRequirements");
const result = summarizeRequirements({ id: "acct_test", identity: { private: "never expose" }, requirements: {
  entries: [{ description: "business_url", reference: { inquiry: "private-token" }, awaiting_action_from: "user",
    minimum_deadline: { status: "currently_due" }, errors: [{ code: "invalid_business_profile_url", description: "Provide your business URL" }] }] } });
assert.equal(result.requirements[0].description, "business_url");
assert.ok(!JSON.stringify(result).includes("private"));
assert.equal(summarizeRequirements({ requirements: { currently_due: ["business_profile.url"] } }).currentlyDue[0], "business_profile.url");
assert.equal(normalizeBusinessWebsite("https://example.ca/services"), "https://example.ca/services");
for (const url of ["javascript:alert(1)", "http://example.ca", "https://user:password@example.ca", "https://localhost", "https://127.0.0.1", "not a url"]) {
  assert.throws(() => normalizeBusinessWebsite(url));
}
assert.equal(normalizeBusinessWebsite(null), null);
console.log("connectRequirements tests passed");
