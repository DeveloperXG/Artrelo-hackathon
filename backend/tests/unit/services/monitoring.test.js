// What leaves for Sentry (instrument.js). Without SENTRY_DSN nothing is sent,
// so this exercises the scrubbing directly: a report must never carry a link
// token, a request body, headers, cookies or more than a user id.

const assert = require("assert");
const { scrubRequest, scrubUrl } = require("../../../instrument");

const TOKEN = "Ab3_-".repeat(9); // 45 chars, the shape of a 32-byte base64url token

assert.strictEqual(
  scrubUrl(`https://api.artrelo.com/api/v1/vendor-portal/${TOKEN}/completion?x=1#y`),
  "https://api.artrelo.com/api/v1/vendor-portal/[redacted]/completion",
  "a job token in the path is redacted; query and fragment dropped"
);
assert.strictEqual(
  scrubUrl("/api/v1/requests/6acf7ddfa3e6961b52d88b74"),
  "/api/v1/requests/6acf7ddfa3e6961b52d88b74",
  "an ordinary id stays, so a report says which request"
);

const event = scrubRequest({
  request: {
    url: `/api/v1/vendor-hub/session/${TOKEN}`,
    data: { password: "hunter2", issueDescription: "water everywhere" },
    headers: { authorization: "Bearer x" },
    cookies: { refresh: "y" },
    query_string: "a=1",
  },
  user: { id: "landlord-1", email: "dana@example.com", ip_address: "203.0.113.7" },
  message: `[sendVendorOutreach] failed for /vendor-response/${TOKEN}`,
  exception: { values: [{ type: "Error", value: `token ${TOKEN} rejected` }] },
  breadcrumbs: [{ category: "http", data: { url: `/vendor-job/${TOKEN}` } }],
});

assert.deepStrictEqual(event.request, { url: "/api/v1/vendor-hub/session/[redacted]" }, "no body, headers or cookies");
assert.deepStrictEqual(event.user, { id: "landlord-1" }, "an id at most: no email, no IP");
assert.strictEqual(event.message, "[sendVendorOutreach] failed for /vendor-response/[redacted]");
assert.strictEqual(event.exception.values[0].value, "token [redacted] rejected");
assert.strictEqual(event.breadcrumbs[0].data.url, "/vendor-job/[redacted]");

// console.error's arguments ride along as extra data. A body-parser error
// carries the whole request body; only its name and message may survive.
const logged = scrubRequest({
  extra: {
    arguments: [
      "[error]",
      { name: "SyntaxError", message: "Unexpected token", body: '{"issueDescription":"water everywhere"}', status: 500 },
      { tenant: { email: "tess@example.com" } },
      `link /vendor-job/${TOKEN}`,
    ],
    somethingElse: { password: "hunter2" },
  },
});
assert.deepStrictEqual(logged.extra, {
  arguments: ["[error]", "SyntaxError: Unexpected token", "[object omitted]", "link /vendor-job/[redacted]"],
});
assert.ok(!JSON.stringify(logged).includes("water everywhere"), "no request body");
assert.ok(!JSON.stringify(logged).includes("tess@example.com"), "no logged objects");
assert.ok(!JSON.stringify(logged).includes("hunter2"), "no other extra data");

// Recent console output rides along as breadcrumbs, arguments and all.
const crumbs = scrubRequest({
  breadcrumbs: [
    { category: "console", message: `[vendorHubLogin] https://artrelo.com/vendor-hub/session/${TOKEN}`, data: { arguments: ["x", { email: "pat@plumbing.test" }], logger: "console" } },
  ],
}).breadcrumbs[0];
assert.strictEqual(crumbs.message, "[vendorHubLogin] https://artrelo.com/vendor-hub/session/[redacted]");
assert.strictEqual(crumbs.data.arguments, undefined, "no raw console arguments");

// A client error (malformed JSON, a 404) is not reported at all.
const clientError = Object.assign(new SyntaxError("Unexpected token"), { status: 400, body: "{bad" });
assert.strictEqual(scrubRequest({ message: "x" }, { originalException: clientError }), null);
const serverError = Object.assign(new Error("boom"), { status: 500 });
assert.ok(scrubRequest({ message: "x" }, { originalException: serverError }), "a 5xx still is");
assert.ok(scrubRequest({ message: "x" }, { originalException: new Error("payout failed") }), "and so is a plain error");

console.log("monitoring tests passed");
