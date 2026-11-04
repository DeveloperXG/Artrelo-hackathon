// "Send feedback": saved first, then emailed to support with the sender as
// Reply-To. Who sent it comes from the session, never from the body.

const assert = require("assert");

const Feedback = require("../../../models/Feedback");
const Landlord = require("../../../models/Landlord");
const Tenant = require("../../../models/Tenant");
const env = require("../../../config/env");

let rows = [];
let updates = [];
let emails = [];
let saveFails = false;
let emailFails = false;
const leanable = (value) => ({ select: () => leanable(value), lean: async () => value });

Feedback.create = async (row) => {
  if (saveFails) throw new Error("db down");
  const saved = { ...row, _id: `fb-${rows.length + 1}` };
  rows.push(saved);
  return saved;
};
Feedback.updateOne = async (filter, update) => {
  updates.push({ filter, update });
  return { modifiedCount: 1 };
};
Landlord.findById = () => leanable({ firstName: "Dana", lastName: "Okafor", email: "dana@example.com", companyName: "Okafor Property" });
Tenant.findById = () => leanable({ firstName: "Tess", lastName: "Tenant", email: "tess@example.com" });
require("../../../services/notification/email.service").sendEmail = async (msg) => {
  if (emailFails) throw new Error("resend down");
  emails.push(msg);
  return { delivered: true };
};

const { submitFeedback } = require("../../../controllers/feedback.controller");

const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});
const call = async (body, user = { id: "landlord-1", role: "landlord" }) => {
  const res = makeRes();
  await submitFeedback({ body, user }, res);
  return res;
};
const reset = () => {
  rows = [];
  updates = [];
  emails = [];
  saveFails = false;
  emailFails = false;
  env.support_email = "support@artrelo.test";
};

async function main() {
  // A landlord's feedback is saved, emailed to support, and replies reach them.
  reset();
  let res = await call({ message: "The Payments page is confusing", page: "/dashboard/wallet?tab=1#x", userId: "someone-else" });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].userId, "landlord-1", "who sent it comes from the session, not the body");
  assert.strictEqual(rows[0].page, "/dashboard/wallet", "the path only, no query or fragment");
  assert.strictEqual(emails[0].to, "support@artrelo.test");
  assert.strictEqual(emails[0].replyTo, "dana@example.com");
  assert.match(emails[0].subject, /Feedback from Dana Okafor \(landlord\)/);
  assert.match(emails[0].text, /Okafor Property/);
  assert.match(emails[0].text, /The Payments page is confusing/);
  assert.strictEqual(updates.length, 1, "marked as emailed");

  // A tenant is labelled as one.
  reset();
  res = await call({ message: "Love it" }, { id: "tenant-1", role: "tenant" });
  assert.match(emails[0].subject, /Tess Tenant \(tenant\)/);
  assert.strictEqual(emails[0].replyTo, "tess@example.com");

  // Too short is refused; nothing saved or sent.
  reset();
  res = await call({ message: "  " });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(rows.length + emails.length, 0);

  // A page that isn't an app path is dropped; header-breaking characters are stripped.
  reset();
  res = await call({ message: "line one\r\nline two\u0007", page: "https://evil.example" });
  assert.strictEqual(rows[0].page, undefined);
  assert.strictEqual(rows[0].message, "line one\nline two");

  // An email outage still keeps the feedback.
  reset();
  emailFails = true;
  const origErr = console.error;
  console.error = () => {};
  res = await call({ message: "Saved even if mail is down" });
  console.error = origErr;
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(updates.length, 0, "not marked as emailed");

  // A database outage still sends the email, but tells the user to retry.
  reset();
  saveFails = true;
  console.error = () => {};
  res = await call({ message: "Emailed even if the database is down" });
  console.error = origErr;
  assert.strictEqual(emails.length, 1);
  assert.strictEqual(res.statusCode, 502);

  console.log("feedback.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
