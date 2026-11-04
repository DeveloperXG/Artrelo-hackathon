// The vendor hub: the first browser session in the system that is neither a
// landlord nor a tenant.
//
// Three properties carry this file:
//
//  1. Login is NOT a vendor-enumeration oracle. Same status, same body, whether
//     or not that email belongs to anyone — otherwise the form becomes a
//     directory of which contractors work through Artrelo.
//  2. A hub session sets req.vendorIdentity and NEVER req.user. Adding a vendor
//     role to userAuth would put every route that forgot an authorize() call
//     one mistake away from a contractor reading a landlord's portfolio.
//  3. A magic link is single-use. Email is forwardable and sits in lock-screen
//     previews; a replayable one is a standing key.

const assert = require("assert");

const VendorIdentity = require("../../../models/VendorIdentity");
const HubSession = require("../../../models/HubSession");

let identityRow = null;
let sessions = [];
let emailsSent = [];
let nextId = 1;

/* ---------------- Stubs -------------------------------------------------- */

VendorIdentity.findOne = async (filter) => {
  if (!identityRow) return null;
  if (filter.emailNormalized && identityRow.emailNormalized !== filter.emailNormalized) return null;
  return identityRow;
};
VendorIdentity.findById = async (id) =>
  identityRow && String(identityRow._id) === String(id) ? identityRow : null;

const matches = (row, filter) =>
  Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && "$gt" in value) return row[key] > value.$gt;
    if (value === null) return row[key] === null || row[key] === undefined;
    return String(row[key]) === String(value);
  });

HubSession.create = async (doc) => {
  const row = { _id: `s${nextId++}`, consumedAt: null, revokedAt: null, usedCount: 0, ...doc };
  sessions.push(row);
  return row;
};
HubSession.findOne = async (filter) => sessions.find((s) => matches(s, filter)) || null;
HubSession.findOneAndUpdate = async (filter, update) => {
  const row = sessions.find((s) => matches(s, filter));
  if (!row) return null;
  Object.assign(row, update.$set || {});
  for (const key of Object.keys(update.$unset || {})) delete row[key];
  for (const [k, d] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + d;
  return row;
};
HubSession.updateOne = async (filter, update) => {
  const row = sessions.find((s) => matches(s, filter));
  if (!row) return { modifiedCount: 0 };
  Object.assign(row, update.$set || {});
  for (const key of Object.keys(update.$unset || {})) delete row[key];
  return { modifiedCount: 1 };
};
HubSession.updateMany = async (filter, update) => {
  let n = 0;
  for (const row of sessions) {
    if (!matches(row, filter)) continue;
    Object.assign(row, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete row[key];
    n += 1;
  }
  return { modifiedCount: n };
};

const emailService = require("../../../services/notification/email.service");
emailService.sendEmail = async (payload) => {
  emailsSent.push(payload);
  return { delivered: true, provider: "stub" };
};

const ctrl = require("../../../controllers/vendorHub.controller");
const { hubAuth, HUB_COOKIE } = require("../../../middleware/hubAuth.middleware");
const { buildMagicUrl } = require("../../../services/vendor/hubSession.service");

const makeRes = () => ({
  statusCode: 200,
  body: null,
  cookies: {},
  cleared: [],
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  cookie(name, value, opts) {
    this.cookies[name] = { value, opts };
    return this;
  },
  clearCookie(name) {
    this.cleared.push(name);
    return this;
  },
});

const makeReq = (overrides = {}) => ({
  body: {},
  params: {},
  cookies: {},
  ip: "203.0.113.5",
  get: () => "test-agent",
  ...overrides,
});

const reset = () => {
  sessions = [];
  emailsSent = [];
  nextId = 1;
  identityRow = {
    _id: "identity-1",
    emailNormalized: "pat@fixit.example",
    displayName: "Pat Okonkwo",
    connectStatus: "enabled",
    mergedInto: null,
    aggregate: { completedJobs: 3, ratingSum: 14, ratingCount: 3 },
  };
};

/** Pull the raw token back out of the emailed link. */
const tokenFromEmail = () => {
  const body = emailsSent[emailsSent.length - 1].text;
  const match = body.match(/vendor-hub\/enter\/([^\s]+)/);
  return match ? match[1] : null;
};

async function main() {
  /* -------------- 1) Login is NOT an enumeration oracle ---------------- */

  reset();
  let res = makeRes();
  await ctrl.requestLoginLink(makeReq({ body: { email: "pat@fixit.example" } }), res);
  const known = { status: res.statusCode, body: JSON.stringify(res.body) };
  assert.strictEqual(emailsSent.length, 1, "a real vendor gets a link");

  reset();
  identityRow = null; // nobody by that address
  res = makeRes();
  await ctrl.requestLoginLink(makeReq({ body: { email: "nobody@nowhere.example" } }), res);
  const unknown = { status: res.statusCode, body: JSON.stringify(res.body) };
  assert.strictEqual(emailsSent.length, 0, "and no mail is sent for a stranger");

  assert.deepStrictEqual(
    known,
    unknown,
    "the response must be byte-identical, or the form becomes a directory of who is on the platform"
  );

  // A malformed address is a client bug, not a signal about who exists — so it
  // IS allowed to differ.
  res = makeRes();
  await ctrl.requestLoginLink(makeReq({ body: { email: "not-an-email" } }), res);
  assert.strictEqual(res.statusCode, 400);

  /* -------------- 2) Magic link is single-use -------------------------- */

  reset();
  await ctrl.requestLoginLink(makeReq({ body: { email: "pat@fixit.example" } }), makeRes());
  const magic = tokenFromEmail();
  assert.ok(magic, "the emailed link carries a token");

  res = makeRes();
  await ctrl.enterWithMagicToken(makeReq({ params: { token: magic } }), res);
  assert.strictEqual(res.statusCode, 200);
  const cookie = res.cookies[HUB_COOKIE];
  assert.ok(cookie, "a session cookie is issued");
  assert.strictEqual(cookie.opts.httpOnly, true, "must be out of reach of page scripts");
  // "lax", not "strict": the vendor ARRIVES by clicking a link in an email,
  // which is a cross-site navigation. Under strict the cookie would not be sent
  // and they would land signed out on the page that just signed them in.
  assert.strictEqual(cookie.opts.sameSite, "lax");

  // Replaying the same link must not mint a second session.
  res = makeRes();
  await ctrl.enterWithMagicToken(makeReq({ params: { token: magic } }), res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.code, "link_expired");
  assert.strictEqual(
    sessions.filter((s) => s.kind === "session").length,
    1,
    "one link, one session"
  );

  /* -------------- 3) Requesting a new link retires the old one --------- */

  reset();
  await ctrl.requestLoginLink(makeReq({ body: { email: "pat@fixit.example" } }), makeRes());
  const firstLink = tokenFromEmail();
  await ctrl.requestLoginLink(makeReq({ body: { email: "pat@fixit.example" } }), makeRes());
  const secondLink = tokenFromEmail();
  assert.notStrictEqual(firstLink, secondLink);

  res = makeRes();
  await ctrl.enterWithMagicToken(makeReq({ params: { token: firstLink } }), res);
  assert.strictEqual(res.statusCode, 401, "the superseded link stops working");

  res = makeRes();
  await ctrl.enterWithMagicToken(makeReq({ params: { token: secondLink } }), res);
  assert.strictEqual(res.statusCode, 200, "the newest link is the one that works");

  /* -------------- 4) hubAuth grants a vendor, never a user ------------- */

  const sessionCookie = res.cookies[HUB_COOKIE].value;
  let req = makeReq({ cookies: { [HUB_COOKIE]: sessionCookie } });
  res = makeRes();
  let reached = false;
  await hubAuth(req, res, () => {
    reached = true;
  });

  assert.strictEqual(reached, true);
  assert.ok(req.vendorIdentity, "the vendor is on the request");
  assert.strictEqual(String(req.vendorIdentity._id), "identity-1");
  assert.strictEqual(
    req.user,
    undefined,
    "a hub session must NEVER produce req.user — authorize() gates landlord routes off exactly that"
  );

  /* -------------- 5) Every rejection looks the same -------------------- */

  const bodies = [];
  for (const cookies of [
    {}, // no cookie
    { [HUB_COOKIE]: "not-a-real-token" }, // forged
  ]) {
    res = makeRes();
    reached = false;
    await hubAuth(makeReq({ cookies }), res, () => {
      reached = true;
    });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(reached, false);
    bodies.push(JSON.stringify(res.body));
  }

  // A revoked session must be indistinguishable from one that never existed.
  await ctrl.signOut(makeReq({ cookies: { [HUB_COOKIE]: sessionCookie } }), makeRes());
  res = makeRes();
  reached = false;
  await hubAuth(makeReq({ cookies: { [HUB_COOKIE]: sessionCookie } }), res, () => {
    reached = true;
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(reached, false, "signing out really ends the session");
  bodies.push(JSON.stringify(res.body));

  assert.strictEqual(
    new Set(bodies).size,
    1,
    `every rejection must be byte-identical, got ${new Set(bodies).size} variants`
  );

  /* -------------- 6) An expired session is refused --------------------- */

  reset();
  await ctrl.requestLoginLink(makeReq({ body: { email: "pat@fixit.example" } }), makeRes());
  res = makeRes();
  await ctrl.enterWithMagicToken(makeReq({ params: { token: tokenFromEmail() } }), res);
  const liveCookie = res.cookies[HUB_COOKIE].value;

  sessions.find((s) => s.kind === "session").expiresAt = new Date(Date.now() - 1000);
  res = makeRes();
  reached = false;
  await hubAuth(makeReq({ cookies: { [HUB_COOKIE]: liveCookie } }), res, () => {
    reached = true;
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(reached, false);

  /* -------------- 7) A merged identity follows the pointer ------------- */
  // mergeIdentities tombstones the loser rather than deleting it, so a vendor
  // holding a session from before a merge should keep working rather than be
  // silently logged out.

  reset();
  await ctrl.requestLoginLink(makeReq({ body: { email: "pat@fixit.example" } }), makeRes());
  res = makeRes();
  await ctrl.enterWithMagicToken(makeReq({ params: { token: tokenFromEmail() } }), res);
  const preMergeCookie = res.cookies[HUB_COOKIE].value;

  const survivor = { _id: "identity-2", displayName: "Pat (merged)", mergedInto: null };
  identityRow = { ...identityRow, mergedInto: "identity-2" };
  VendorIdentity.findById = async (id) =>
    String(id) === "identity-2" ? survivor : identityRow;

  req = makeReq({ cookies: { [HUB_COOKIE]: preMergeCookie } });
  res = makeRes();
  reached = false;
  await hubAuth(req, res, () => {
    reached = true;
  });
  assert.strictEqual(reached, true, "a merge must not sign the vendor out");
  assert.strictEqual(String(req.vendorIdentity._id), "identity-2", "they get the survivor");

  /* -------------- 8) The emailed link says its own lifetime ------------ */
  // A vendor opening it an hour later should know why it failed, rather than
  // concluding the product is broken.

  reset();
  await ctrl.requestLoginLink(makeReq({ body: { email: "pat@fixit.example" } }), makeRes());
  const mail = emailsSent[0];
  assert.ok(mail.text.includes("15 minutes"));
  assert.ok(mail.text.includes("once"));
  assert.ok(buildMagicUrl("abc").includes("/vendor-hub/enter/abc"));

  console.log("vendorHub.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
