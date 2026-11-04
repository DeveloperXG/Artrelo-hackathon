// Inbound vendor SMS: signature verification and delivery.
//
// The reason this file exists at all is the lesson from slices B and C — twice,
// a fully green suite hid a real bug because the stub encoded the same wrong
// assumption as the code. A signature verifier tested only against signatures
// this same file produced proves nothing: it proves the code agrees with
// itself, which is exactly the failure mode.
//
// So section 1 pins the implementation against TWILIO'S OWN PUBLISHED TEST
// VECTOR — their documented example URL, parameters, auth token and expected
// signature. If our concatenation order, our treatment of the query string, or
// our hash choice drifts, that assertion fails against an external fact rather
// than against our own opinion. It is the closest thing to a live sandbox
// available while A2P 10DLC registration is still pending.

const assert = require("assert");
const crypto = require("crypto");

const env = require("../../../config/env");

const ACCOUNT_TOKEN = "test-auth-token";
const PROXY = "+15551110000";
const VENDOR = "+13065550101";
const WEBHOOK_URL = "https://api.example.com/api/v1/webhooks/twilio/sms";

env.twilio_auth_token = ACCOUNT_TOKEN;
env.twilio_webhook_url = WEBHOOK_URL;
env.twilio_proxy_numbers = [PROXY];

/* ---------------------------------------------------------------- fixtures */

const ProxySession = require("../../../models/ProxySession");

let sessionRow = null;
let closedRow = null;
let updates = [];

function chain(value) {
  const self = {
    select: () => self,
    sort: () => self,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return self;
}

ProxySession.findOne = (filter) => {
  if (filter.status === "closed") return chain(closedRow);
  const match =
    sessionRow &&
    sessionRow.status === "open" &&
    (!filter.vendorPhoneE164 || filter.vendorPhoneE164 === sessionRow.vendorPhoneE164) &&
    (!filter.proxyNumber || filter.proxyNumber === sessionRow.proxyNumber);
  return chain(match ? sessionRow : null);
};
ProxySession.updateOne = async (filter, update) => {
  updates.push(update);
  if (sessionRow && update.$set) Object.assign(sessionRow, update.$set);
  return { modifiedCount: 1 };
};

// The delivery layer and the audit log are exercised by their own specs; here
// they only need to record that they were reached.
const relayMessaging = require("../../../services/comms/relayMessaging.service");
let delivered = [];
relayMessaging.deliverInboundVendorMessage = async ({ session, body }) => {
  delivered.push({ sessionId: String(session._id), body });
  return { delivered: true };
};

const smsService = require("../../../services/notification/sms.service");
let sent = [];
smsService.sendSms = async (args) => {
  sent.push(args);
  return { delivered: true, provider: "twilio" };
};

const agentAction = require("../../../services/audit/agentAction.service");
let logged = [];
agentAction.logAgentAction = async (entry) => {
  logged.push(entry);
  return null;
};

const {
  handleTwilioInboundSms,
  buildSignatureBase,
  parseFormBody,
  EMPTY_TWIML,
} = require("../../../controllers/twilioWebhook.controller");

/* ------------------------------------------------------------ test harness */

function sign(url, params, token = ACCOUNT_TOKEN) {
  return crypto
    .createHmac("sha1", token)
    .update(Buffer.from(buildSignatureBase(url, params), "utf8"))
    .digest("base64");
}

function makeReq(params, { signature, headers = {} } = {}) {
  const body = Buffer.from(new URLSearchParams(params).toString(), "utf8");
  const all = {
    "x-twilio-signature": signature === undefined ? sign(WEBHOOK_URL, params) : signature,
    ...headers,
  };
  return {
    body,
    originalUrl: "/api/v1/webhooks/twilio/sms",
    protocol: "https",
    get: (name) => all[String(name).toLowerCase()],
  };
}

function makeRes() {
  const res = { statusCode: null, contentType: null, payload: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.type = (value) => {
    res.contentType = value;
    return res;
  };
  res.send = (payload) => {
    res.payload = payload;
    return res;
  };
  return res;
}

function reset() {
  delivered = [];
  sent = [];
  logged = [];
  updates = [];
  closedRow = null;
  env.twilio_auth_token = ACCOUNT_TOKEN;
  sessionRow = {
    _id: "sess-1",
    status: "open",
    proxyNumber: PROXY,
    vendorPhoneE164: VENDOR,
    requestId: "req-1",
    landlordId: "landlord-1",
    tenantId: "tenant-1",
    identityId: "ident-1",
    vendorNameSnapshot: "Northline Plumbing",
    lastInboundSid: null,
  };
}

const inbound = (overrides = {}) => ({
  MessageSid: "SM00000000000000000000000000000001",
  AccountSid: "AC00000000000000000000000000000001",
  From: VENDOR,
  To: PROXY,
  Body: "Running about 20 minutes late, tell them not to worry",
  NumMedia: "0",
  ...overrides,
});

/* -------------------------------------------------------------------- tests */

async function main() {
  /* -- 1) The signature scheme, pinned to Twilio's published vector -------- */
  // Their documented example. If any of it drifts — sort order, the query
  // string staying in the URL, SHA1, base64 — this fails against an external
  // fact rather than against a signature we generated ourselves.

  const twilioDocsUrl = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const twilioDocsParams = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675309",
    Digits: "1234",
    From: "+14158675309",
    To: "+18005551212",
  };
  assert.strictEqual(
    sign(twilioDocsUrl, twilioDocsParams, "12345"),
    "RSOYDt4T1cUTdK1PDd93/VVr8B8=",
    "our HMAC must reproduce Twilio's own documented signature"
  );

  // Parameters are sorted by KEY and concatenated with no separator, appended
  // to the URL exactly as posted. Spelling this out because it is the detail
  // that silently breaks and then looks like a wrong auth token.
  assert.strictEqual(
    buildSignatureBase("https://x/y", { b: "2", a: "1" }),
    "https://x/ya1b2"
  );

  /* -- 2) A valid message reaches the tenant's thread ---------------------- */

  reset();
  let res = makeRes();
  await handleTwilioInboundSms(makeReq(inbound()), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.payload, EMPTY_TWIML, "empty TwiML: no auto-reply down the SMS leg");
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].sessionId, "sess-1");
  assert.strictEqual(logged.length, 1);
  assert.strictEqual(logged[0].actionType, "relay_message_received");

  // The audit trail records THAT a vendor made contact, never what they said.
  // The contents belong in the request thread and nowhere else.
  const serializedLog = JSON.stringify(logged[0]);
  assert.ok(
    !serializedLog.includes("20 minutes late"),
    "the message body must not be copied into the audit log"
  );

  /* -- 3) A forged signature is rejected ---------------------------------- */
  // The whole point. Without this, anyone who learns the URL can post a message
  // that appears in a tenant's thread attributed to the vendor in their home.

  reset();
  res = makeRes();
  await handleTwilioInboundSms(makeReq(inbound(), { signature: "bogus" }), res);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(delivered.length, 0);

  // A signature valid for DIFFERENT content is still a forgery: the body is
  // covered by the HMAC, not just the URL.
  reset();
  res = makeRes();
  const params = inbound();
  const tampered = { ...params, Body: "The job is done, please release payment" };
  await handleTwilioInboundSms(
    makeReq(tampered, { signature: sign(WEBHOOK_URL, params) }),
    res
  );
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(delivered.length, 0);

  // A signature computed with someone else's auth token is a forgery.
  reset();
  res = makeRes();
  await handleTwilioInboundSms(
    makeReq(inbound(), { signature: sign(WEBHOOK_URL, inbound(), "wrong-token") }),
    res
  );
  assert.strictEqual(res.statusCode, 403);

  // A missing header is not treated as "nothing to check".
  reset();
  res = makeRes();
  await handleTwilioInboundSms(makeReq(inbound(), { signature: null }), res);
  assert.strictEqual(res.statusCode, 403);

  /* -- 4) No auth token configured => switched off, not wide open --------- */
  // Same stance the Stripe handler takes on a missing webhook secret. An
  // endpoint that accepts unverified payloads is worse than one that is off.

  reset();
  env.twilio_auth_token = null;
  res = makeRes();
  await handleTwilioInboundSms(makeReq(inbound(), { signature: "anything" }), res);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(delivered.length, 0);
  env.twilio_auth_token = ACCOUNT_TOKEN;

  /* -- 5) An unroutable message answers 200, not 500 ---------------------- */
  // Twilio retries a non-2xx. None of these get better on a retry, and a retry
  // of a handler that already appended a comment double-posts it.

  reset();
  sessionRow = null;
  res = makeRes();
  await handleTwilioInboundSms(makeReq(inbound()), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(delivered.length, 0);
  assert.strictEqual(sent.length, 0, "no reply to a pair we have no record of — not a reflector");

  /* -- 6) A recently closed channel earns one courtesy reply -------------- */
  // Otherwise a vendor texting the morning after a job closed hears silence and
  // concludes the tenant is ignoring them.

  reset();
  sessionRow = null;
  closedRow = { _id: "sess-old", status: "closed", proxyNumber: PROXY, vendorPhoneE164: VENDOR };
  res = makeRes();
  await handleTwilioInboundSms(makeReq(inbound()), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, VENDOR);
  assert.strictEqual(sent[0].from, PROXY, "the reply comes from the proxy, never a bare default");

  /* -- 7) Inbound to a number that is not ours is ignored ----------------- */

  reset();
  res = makeRes();
  await handleTwilioInboundSms(makeReq(inbound({ To: "+15559990000" })), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(delivered.length, 0);

  /* -- 8) A Twilio retry does not double-post ----------------------------- */
  // Retries carry the same MessageSid. Two identical messages in a tenant's
  // thread reads as the vendor repeating themselves.

  reset();
  await handleTwilioInboundSms(makeReq(inbound()), makeRes());
  assert.strictEqual(delivered.length, 1);
  await handleTwilioInboundSms(makeReq(inbound()), makeRes());
  assert.strictEqual(delivered.length, 1, "the same MessageSid delivers once");

  // A genuinely new message on the same session still goes through.
  await handleTwilioInboundSms(
    makeReq(inbound({ MessageSid: "SM00000000000000000000000000000002", Body: "At the door" })),
    makeRes()
  );
  assert.strictEqual(delivered.length, 2);

  /* -- 9) The raw form body is parsed, not assumed to be an object -------- */
  // This route is mounted with express.raw for x-www-form-urlencoded. If it
  // were ever mounted after the global body parsers, req.body would arrive
  // parsed and the reconstructed signature would never match.

  const parsed = parseFormBody(
    Buffer.from("From=%2B13065550101&Body=Hi+there%2C+running+late", "utf8")
  );
  assert.strictEqual(parsed.From, "+13065550101");
  assert.strictEqual(parsed.Body, "Hi there, running late");

  console.log("twilioWebhook.controller: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
