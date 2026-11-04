// The marketing site's only lead channel.
//
// THE RULE THIS FILE EXISTS TO PROTECT: a valid enquiry always leaves a durable
// row. Before Lead existed, the sole effect of this endpoint was an email, so an
// unconfigured provider meant every visitor saw a success screen while the lead
// evaporated — silently, because a stub is indistinguishable from a send at the
// call site. Persisting first is what makes that recoverable.
//
// Two corollaries get their own cases below: persistence must never cost us the
// email (case 6), and delivery must never cost us the row (case 7).

const assert = require("assert");

const Lead = require("../../../models/Lead");
const emailService = require("../../../services/notification/email.service");
const env = require("../../../config/env");

/* ---------------- Stubs -------------------------------------------------- */
//
// sendEmail is destructured at controller load, so it must be replaced BEFORE
// the controller is required — patching it afterwards would rebind the module
// export while the controller kept its own captured reference.

let sendResult = { delivered: true, stub: false, messageId: "msg_1" };
let sent = [];
emailService.sendEmail = async (args) => {
  sent.push(args);
  return sendResult;
};

let created = [];
let updates = [];
let createThrows = false;
let nextId = 1;

Lead.create = async (doc) => {
  if (createThrows) throw new Error("mongo unavailable");
  const row = { _id: `lead${nextId++}`, ...doc };
  created.push(row);
  return row;
};
Lead.updateOne = async (filter, update) => {
  updates.push({ filter, update });
  return { modifiedCount: 1 };
};

// The per-address ceiling. Defaults to "no recent leads" so the cases above
// the limit section exercise the normal path; left unstubbed, the real query
// would sit in Mongoose's buffer waiting for a connection that never comes.
let recentCount = 0;
let countThrows = false;
let countQueries = [];
Lead.countDocuments = async (filter) => {
  countQueries.push(filter);
  if (countThrows) throw new Error("mongo unavailable");
  return recentCount;
};

const ctrl = require("../../../controllers/publicContact.controller");

/* ---------------- Helpers ------------------------------------------------ */

const VALID = {
  name: "Dana Okafor",
  email: "dana@parkviewpm.com",
  company: "Parkview Property Group",
  size: "251–1,000 units",
  message: "We manage 400 doors and maintenance coordination is eating our week.",
};

function makeReq(body) {
  return { body };
}

function makeRes() {
  return {
    statusCode: 0,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

// Captures console.error so the misconfiguration alarm can be asserted on
// rather than merely assumed. Restores on every reset.
const realError = console.error;
let logged = [];

function reset() {
  created = [];
  updates = [];
  sent = [];
  logged = [];
  createThrows = false;
  recentCount = 0;
  countThrows = false;
  countQueries = [];
  sendResult = { delivered: true, stub: false, messageId: "msg_1" };
  env.node_env = "dev";
  console.error = (...args) => logged.push(args.map(String).join(" "));
}

async function main() {
  /* -------------- 1) Happy path: row first, then delivery -------------- */

  reset();
  let res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(created.length, 1, "a valid enquiry must leave a row");
  assert.strictEqual(created[0].name, VALID.name);
  assert.strictEqual(created[0].email, VALID.email);
  assert.strictEqual(created[0].company, VALID.company);
  assert.strictEqual(created[0].portfolioSize, "251–1,000 units");
  assert.strictEqual(created[0].sourcePage, "/contact", "defaults when unspecified");
  assert.strictEqual(sent.length, 1, "and still sends the email");
  assert.strictEqual(sent[0].replyTo, VALID.email, "visitor goes in Reply-To, never From");

  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].update.deliveryStatus, "delivered");
  assert.strictEqual(updates[0].update.providerMessageId, "msg_1");

  /* -------------- 2) Honeypot: no row, no send, still 200 -------------- */

  reset();
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID, website: "http://spam.example" }), res);

  assert.strictEqual(res.statusCode, 200, "bots must see the same shape as success");
  assert.strictEqual(created.length, 0, "bot submissions must not pollute the lead table");
  assert.strictEqual(sent.length, 0);

  /* -------------- 3) Invalid input: no row, no send -------------------- */

  reset();
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID, email: "not-an-email" }), res);

  assert.strictEqual(res.statusCode, 400);
  assert.ok(res.payload.errors.email, "field-level error keyed for the client");
  assert.strictEqual(created.length, 0, "validation runs before persistence");
  assert.strictEqual(sent.length, 0);

  /* -------------- 4) Stub in dev: recorded, quiet, still 200 ----------- */

  reset();
  sendResult = { delivered: false, stub: true, provider: "stub", messageId: null };
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID }), res);

  assert.strictEqual(res.statusCode, 200, "local dev must not read as a failure");
  assert.strictEqual(updates[0].update.deliveryStatus, "stubbed");
  assert.ok(
    !logged.some((l) => l.includes("MISCONFIGURED")),
    "a stub in dev is the expected path, not an alarm"
  );

  /* -------------- 5) Stub in production: the alarm --------------------- */

  reset();
  env.node_env = "production";
  sendResult = { delivered: false, stub: true, provider: "stub", messageId: null };
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID }), res);

  assert.strictEqual(res.statusCode, 200, "the visitor is not the one to punish");
  assert.strictEqual(created.length, 1, "the row is what makes this recoverable");
  assert.strictEqual(updates[0].update.deliveryStatus, "stubbed");
  assert.ok(
    logged.some((l) => l.includes("MISCONFIGURED")),
    "an unconfigured provider in production must be loud — it is silent by construction"
  );

  /* -------------- 6) DB down: the email still goes ---------------------- */

  reset();
  createThrows = true;
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(sent.length, 1, "a persistence fault must not cost us the only other channel");
  assert.strictEqual(updates.length, 0, "nothing to patch when there is no row");
  assert.ok(logged.some((l) => l.includes("lead persist failed")));

  /* -------------- 7) Delivery fails: row survives, 502 ------------------ */

  reset();
  sendResult = { delivered: false, stub: false, error: "resend 500" };
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID }), res);

  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(created.length, 1, "a hard delivery failure must still leave the lead");
  assert.strictEqual(
    updates[0].update.deliveryStatus,
    "failed",
    "patched before the 502 returns, so the row is never left stale at pending"
  );
  assert.strictEqual(updates[0].update.deliveryError, "resend 500");

  /* -------------- 8) sourcePage distinguishes the funnels --------------- */

  reset();
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID, sourcePage: "/demo" }), res);
  assert.strictEqual(created[0].sourcePage, "/demo", "/demo must be measurable separately");

  /* -------------- 9) Unknown portfolio size is coerced, not fatal ------- */

  reset();
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID, size: "some drifted option" }), res);

  assert.strictEqual(res.statusCode, 200, "a drifted <select> must never fail a real lead");
  assert.strictEqual(created[0].portfolioSize, "Not specified");

  /* -------------- 10) Per-address ceiling: refused, nothing written ----- */

  reset();
  recentCount = 2;
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID }), res);

  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(res.payload.code, "duplicate", "the client can tell this apart from a flood");
  assert.strictEqual(created.length, 0, "a refused submission must not leave a duplicate row");
  assert.strictEqual(sent.length, 0, "nor a duplicate email");

  /* -------------- 11) Under the ceiling: accepted ----------------------- */

  reset();
  recentCount = 1;
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID, sourcePage: "/demo" }), res);

  assert.strictEqual(res.statusCode, 200, "/contact then /demo on the same day is a normal path");
  assert.strictEqual(created.length, 1);

  /* -------------- 12) The count query is scoped correctly --------------- */

  reset();
  const before = Date.now();
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID, email: "Dana@ParkviewPM.com" }), res);

  assert.strictEqual(countQueries.length, 1);
  const q = countQueries[0];
  assert.strictEqual(q.email, "dana@parkviewpm.com", "rows are stored lowercased, so the lookup must be too");
  assert.deepStrictEqual(
    q.deliveryStatus,
    { $ne: "failed" },
    "a failed send invited a retry — it must not count against that retry"
  );
  const windowMs = before - q.createdAt.$gte.getTime();
  assert.ok(
    windowMs >= 24 * 60 * 60 * 1000 - 1000 && windowMs <= 24 * 60 * 60 * 1000 + 1000,
    `the window must be one day, got ${windowMs}ms`
  );

  /* -------------- 13) Count query fails: fail open --------------------- */

  reset();
  countThrows = true;
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID }), res);

  assert.strictEqual(res.statusCode, 200, "a broken count must not turn every visitor away");
  assert.strictEqual(sent.length, 1);
  assert.ok(logged.some((l) => l.includes("recent-lead count failed")), "and it must say so");

  /* -------------- 14) Cheap rejections never reach the database -------- */

  reset();
  res = makeRes();
  await ctrl.submitContactInquiry(makeReq({ ...VALID, website: "http://spam.example" }), res);
  await ctrl.submitContactInquiry(makeReq({ ...VALID, email: "not-an-email" }), makeRes());
  assert.strictEqual(countQueries.length, 0, "honeypot and invalid input are refused before any query");

  console.error = realError;
  console.log("publicContact.controller tests passed");
}

main().catch((err) => {
  console.error = realError;
  console.error(err);
  process.exit(1);
});
