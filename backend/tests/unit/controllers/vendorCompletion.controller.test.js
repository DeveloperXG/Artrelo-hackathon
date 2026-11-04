// The vendor's completion surface — the second unauthenticated, state-changing
// endpoint group in the API.
//
// What is pinned here is the security behaviour, not the happy path: the
// byte-identical generic 404, the appointment-state gate that bounds a leaked
// token's abuse window, the server-enforced photo cap, and the single-use
// submit. Plus the property that the submit body carries no URLs at all, so a
// token holder cannot write an arbitrary asset into a landlord's record.

const assert = require("assert");

const Appointment = require("../../../models/Appointment");
const JobCompletion = require("../../../models/JobCompletion");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const LandlordPolicy = require("../../../models/LandlordPolicy");
const Property = require("../../../models/Property");
const VendorOutreach = require("../../../models/VendorOutreach");
const JobToken = require("../../../models/JobToken");
const AgentActionLog = require("../../../models/AgentActionLog");
const cloudinary = require("../../../services/upload/cloudinary.service");

const RAW_TOKEN = "raw-job-token-value";
const APPT_ID = "appt-1";

let tokenRow = null;
let appointmentRow = null;
let completionRow = null;
let audits = [];
let uploadCalls = [];

const makeToken = (overrides = {}) => ({
  _id: "tok-1",
  scope: "job",
  outreachId: "outreach-1",
  requestId: "req-1",
  appointmentId: APPT_ID,
  landlordId: "landlord-1",
  identityId: "identity-1",
  vendorId: "vendor-1",
  vendorNameSnapshot: "Northline Plumbing",
  revokedAt: null,
  expiresAt: new Date(Date.now() + 86400000),
  ...overrides,
});

const makeAppointment = (overrides = {}) => ({
  _id: APPT_ID,
  requestId: "req-1",
  landlordId: "landlord-1",
  tenantId: "tenant-1",
  vendorId: "vendor-1",
  status: "scheduled",
  ...overrides,
});

const makeCompletion = (overrides = {}) => ({
  _id: "comp-1",
  appointmentId: APPT_ID,
  status: "draft",
  photos: [],
  report: {},
  ...overrides,
});

/* ---------------- Stubs ------------------------------------------------ */

JobToken.findOne = async (filter) => {
  if (!tokenRow) return null;
  if (filter.scope && tokenRow.scope !== filter.scope) return null;
  return tokenRow;
};
JobToken.updateOne = async () => ({ modifiedCount: 1 });

Appointment.findById = async (id) =>
  appointmentRow && String(appointmentRow._id) === String(id) ? appointmentRow : null;
Appointment.updateOne = async (filter, update) => {
  if (appointmentRow && (!filter.status || appointmentRow.status === filter.status)) {
    Object.assign(appointmentRow, update.$set || {});
  }
  return { modifiedCount: 1 };
};

JobCompletion.findOne = async () => completionRow;
JobCompletion.create = async (doc) => {
  completionRow = makeCompletion(doc);
  return completionRow;
};
JobCompletion.findOneAndUpdate = async (filter, update) => {
  if (!completionRow) return null;
  if (filter.status && completionRow.status !== filter.status) return null;
  // Emulate the array-length guard: photos.{MAX-1} must not exist.
  const capKey = Object.keys(filter).find((key) => key.startsWith("photos."));
  if (capKey) {
    const index = Number(capKey.split(".")[1]);
    if (completionRow.photos.length > index) return null;
  }
  if (update.$push?.photos) completionRow.photos.push(update.$push.photos);
  Object.assign(completionRow, update.$set || {});
  return completionRow;
};

MaintenanceRequest.findById = (id) => ({
  select: () => ({ lean: async () => ({ _id: id, propertyId: "prop-1", estimatedCost: 300 }) }),
});
MaintenanceRequest.updateOne = async () => ({ modifiedCount: 1 });
Property.findById = () => ({ select: () => ({ lean: async () => ({ _id: "prop-1" }) }) });
// submitCompletion resolves the approved ceiling before it writes anything, so
// the policy lookup has to be stubbed even though no test here goes over it.
// Overage behaviour itself is covered in vendorCompletion.overage.test.js.
LandlordPolicy.findOne = () => ({ lean: async () => ({ defaultQuota: 300 }) });
VendorOutreach.findById = () => ({
  select: () => ({ lean: async () => ({ response: { quoteHigh: 300 } }) }),
});
AgentActionLog.create = async (row) => {
  audits.push(row);
  return row;
};

cloudinary.isConfigured = () => true;
cloudinary.uploadBuffer = async (buffer, opts) => {
  uploadCalls.push(opts);
  return {
    url: `https://cdn.example.com/${uploadCalls.length}.jpg`,
    publicId: `p${uploadCalls.length}`,
    type: "image",
    format: "jpg",
    bytes: 1024,
    width: 100,
    height: 100,
    exifTakenAt: null,
  };
};

const { requireJobToken, GENERIC_NOT_FOUND } = require("../../../middleware/jobToken.middleware");
const ctrl = require("../../../controllers/vendorCompletion.controller");

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const makeReq = (overrides = {}) => ({
  params: { token: RAW_TOKEN },
  body: {},
  ip: "203.0.113.9",
  get: () => "test-agent",
  ...overrides,
});

/** Runs the middleware then the handler, exactly as the router chains them. */
async function run(handler, req, { middlewareOpts = {} } = {}) {
  const res = makeRes();
  let reached = false;
  await requireJobToken(middlewareOpts)(req, res, async () => {
    reached = true;
    await handler(req, res);
  });
  return { res, reached };
}

const reset = () => {
  tokenRow = makeToken();
  appointmentRow = makeAppointment();
  completionRow = null;
  audits = [];
  uploadCalls = [];
};

const validSubmission = {
  workPerformed: "Replaced the P-trap and resealed the basin waste",
  partsUsed: "1x P-trap",
  actualCost: 240,
};

async function main() {
  /* -------------- 1) Every dead-token case is byte-identical ----------- */

  const bodies = [];
  for (const mutate of [
    () => (tokenRow = null), // never existed
    () => (tokenRow = makeToken({ revokedAt: new Date() })), // retired at close
    () => (tokenRow = makeToken({ expiresAt: new Date(Date.now() - 1000) })), // expired
    () => (tokenRow = makeToken({ scope: "offer" })), // wrong scope
    () => (appointmentRow = null), // appointment vanished
  ]) {
    reset();
    mutate();
    const { res, reached } = await run(ctrl.getCompletion, makeReq());
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(reached, false, "the handler must never run for a bad token");
    bodies.push(JSON.stringify(res.body));
  }

  const unique = new Set(bodies);
  assert.strictEqual(
    unique.size,
    1,
    `every dead-token response must be byte-identical, got ${unique.size} variants`
  );
  assert.strictEqual(bodies[0], JSON.stringify(GENERIC_NOT_FOUND));

  /* -------------- 2) The appointment-state gate ------------------------ */
  // Uploads are impossible before the tenant confirms the time and after the
  // job closes, so a leaked token's abuse window is bounded by the JOB's
  // lifecycle rather than the token's.

  for (const status of ["proposed", "awaiting_tenant", "completed", "cancelled", "in_review", "disputed"]) {
    reset();
    appointmentRow = makeAppointment({ status });
    const { res, reached } = await run(ctrl.uploadCompletionPhoto, makeReq());
    assert.strictEqual(res.statusCode, 404, `${status} must not admit a completion write`);
    assert.strictEqual(reached, false);
  }

  for (const status of ["scheduled", "work_verifying"]) {
    reset();
    appointmentRow = makeAppointment({ status });
    const { reached } = await run(ctrl.getCompletion, makeReq());
    assert.strictEqual(reached, true, `${status} must admit the handler`);
  }

  // READS are wider than writes: a vendor whose submission is under review has
  // done the work and sent it in. Showing them a dead link at that point is
  // both alarming and wrong — they can look, they just cannot change anything.
  for (const status of ["in_review", "disputed"]) {
    reset();
    appointmentRow = makeAppointment({ status });
    const { reached } = await run(ctrl.getCompletion, makeReq(), {
      middlewareOpts: { readOnly: true },
    });
    assert.strictEqual(reached, true, `${status} must still be readable by the vendor`);
  }

  /* -------------- 3) Photo cap is enforced server-side ----------------- */

  reset();
  const max = ctrl.MAX_COMPLETION_PHOTOS;
  for (let i = 0; i < max; i += 1) {
    const { res } = await run(
      ctrl.uploadCompletionPhoto,
      makeReq({ file: { buffer: Buffer.from("x"), originalname: `p${i}.jpg` } }),
      { middlewareOpts: { requireDraftCompletion: true } }
    );
    assert.strictEqual(res.statusCode, 201, `upload ${i + 1} should succeed`);
  }

  const { res: capped } = await run(
    ctrl.uploadCompletionPhoto,
    makeReq({ file: { buffer: Buffer.from("x"), originalname: "extra.jpg" } }),
    { middlewareOpts: { requireDraftCompletion: true } }
  );
  assert.strictEqual(capped.statusCode, 409);
  assert.strictEqual(capped.body.code, "photo_limit_reached");
  assert.strictEqual(completionRow.photos.length, max, "the cap must hold");

  // The Cloudinary folder is derived ENTIRELY from server state — a
  // client-supplied path would let a token holder write into another
  // landlord's namespace.
  assert.ok(uploadCalls[0].folder.includes("landlord-1"));
  assert.ok(uploadCalls[0].folder.includes(APPT_ID));
  assert.strictEqual(uploadCalls[0].imageMetadata, true, "EXIF is needed for the staleness check");

  /* -------------- 4) Submit validation --------------------------------- */

  const badBodies = [
    [{}, "missing everything"],
    [{ workPerformed: "short", actualCost: 100 }, "description too short"],
    [{ ...validSubmission, actualCost: -5 }, "negative cost"],
    [{ ...validSubmission, actualCost: 2000000 }, "cost out of range"],
    [{ ...validSubmission, actualCost: "abc" }, "non-numeric cost"],
    [
      { ...validSubmission, completedAt: new Date(Date.now() + 5 * 86400000).toISOString() },
      "completed in the future",
    ],
  ];
  for (const [body, label] of badBodies) {
    reset();
    completionRow = makeCompletion();
    const { res } = await run(ctrl.submitCompletion, makeReq({ body }), {
      middlewareOpts: { requireDraftCompletion: true },
    });
    assert.strictEqual(res.statusCode, 400, `should reject: ${label}`);
  }

  /* -------------- 5) Submit is single-use ------------------------------ */

  reset();
  // Good evidence, so this lands in awaiting_tenant / work_verifying and the
  // SECOND attempt is stopped by the completion-status gate rather than by the
  // appointment-state one. (Weak evidence is also rejected on resubmit, just
  // with a 404 from the earlier gate — see section 6.)
  completionRow = makeCompletion({
    photos: [{ url: "https://cdn.example.com/a.jpg", stage: "after", receivedAt: new Date() }],
    checkIn: { source: "client_reported", lat: 50.4, lng: -104.6, at: new Date() },
  });
  const { res: first } = await run(ctrl.submitCompletion, makeReq({ body: validSubmission }), {
    middlewareOpts: { requireDraftCompletion: true },
  });
  assert.strictEqual(first.statusCode, 200);
  assert.ok(audits.some((a) => a.actionType === "vendor_completion_submitted"));

  // Second attempt: the middleware itself now rejects it, before any handler.
  const { res: second, reached } = await run(
    ctrl.submitCompletion,
    makeReq({ body: validSubmission }),
    { middlewareOpts: { requireDraftCompletion: true } }
  );
  assert.strictEqual(second.statusCode, 409);
  assert.strictEqual(second.body.code, "already_submitted");
  assert.strictEqual(reached, false, "a resubmit must not reach the handler at all");

  /* -------------- 6) No photo STILL goes to the tenant ----------------- */
  // Weak evidence used to park in in_review, putting the manager in front of a
  // question the tenant is better placed to answer — they were in the room. The
  // verdict is still recorded, but it now gates AUTO-CONFIRM in
  // completionSweeper rather than tenant review, so the tenant sees every
  // completion and silence is the only thing the evidence can veto.

  reset();
  completionRow = makeCompletion({ photos: [] });
  await run(ctrl.submitCompletion, makeReq({ body: validSubmission }), {
    middlewareOpts: { requireDraftCompletion: true },
  });
  assert.strictEqual(
    completionRow.status,
    "awaiting_tenant",
    "the tenant is asked whatever the evidence said"
  );
  assert.strictEqual(
    completionRow.evidenceVerdict,
    "review",
    "but the verdict is still recorded — a dispute depends on it"
  );
  assert.ok(
    (completionRow.evidenceReasons || []).includes("no_after_photo"),
    "and so is the reason"
  );
  assert.ok(
    completionRow.autoConfirmAt,
    "it carries a timer, which doubles as the escalation deadline"
  );
  assert.strictEqual(appointmentRow.status, "work_verifying");

  // ...and once submitted, further writes are still closed off — but by the
  // requireDraftCompletion guard rather than the appointment-status gate. The
  // appointment is `work_verifying` now instead of `in_review`, which IS an
  // uploadable status, so the completion's own status is what stops it. That is
  // the more robust of the two checks and it sits in the middleware precisely
  // so no endpoint can forget it.
  const { res: locked, reached: lockedReached } = await run(
    ctrl.uploadCompletionPhoto,
    makeReq({ file: { buffer: Buffer.from("x"), originalname: "late.jpg" } }),
    { middlewareOpts: { requireDraftCompletion: true } }
  );
  assert.strictEqual(locked.statusCode, 409);
  assert.strictEqual(locked.body.code, "already_submitted");
  assert.strictEqual(lockedReached, false, "the handler is never reached");

  /* -------------- 7) Good evidence => awaiting_tenant + timer ---------- */

  reset();
  completionRow = makeCompletion({
    photos: [{ url: "https://cdn.example.com/a.jpg", stage: "after", receivedAt: new Date() }],
    checkIn: { source: "client_reported", lat: 50.4, lng: -104.6, at: new Date() },
  });
  await run(ctrl.submitCompletion, makeReq({ body: validSubmission }), {
    middlewareOpts: { requireDraftCompletion: true },
  });
  assert.strictEqual(completionRow.status, "awaiting_tenant");
  assert.ok(completionRow.autoConfirmAt > new Date(), "the tenant gets a deadline");
  assert.strictEqual(appointmentRow.status, "work_verifying");
  assert.strictEqual(completionRow.report.actualCost, 240);

  /* -------------- 8) The submit body carries no URLs ------------------- */
  // Photos are appended server-side to a draft, so there is nothing
  // client-supplied to validate into a landlord's record.

  reset();
  completionRow = makeCompletion();
  await run(
    ctrl.submitCompletion,
    makeReq({
      body: {
        ...validSubmission,
        photos: [{ url: "https://evil.example.com/x.jpg" }],
        url: "https://evil.example.com/y.jpg",
      },
    }),
    { middlewareOpts: { requireDraftCompletion: true } }
  );
  assert.strictEqual(
    JSON.stringify(completionRow.photos).includes("evil.example.com"),
    false,
    "a client-supplied URL must never reach the stored record"
  );

  /* -------------- 9) Denied geolocation is recorded, not rejected ------ */

  reset();
  completionRow = makeCompletion();
  const { res: denied } = await run(
    ctrl.recordCheckpoint,
    makeReq({ body: { kind: "checkIn", denied: true } }),
    { middlewareOpts: { requireDraftCompletion: true } }
  );
  assert.strictEqual(denied.statusCode, 200, "a permission refusal must not block the vendor");
  assert.strictEqual(completionRow.checkIn.source, "denied");

  // Out-of-range coordinates are still rejected as malformed input.
  reset();
  completionRow = makeCompletion();
  const { res: bad } = await run(
    ctrl.recordCheckpoint,
    makeReq({ body: { kind: "checkIn", lat: 999, lng: 0 } }),
    { middlewareOpts: { requireDraftCompletion: true } }
  );
  assert.strictEqual(bad.statusCode, 400);

  // A good reading is labelled client_reported on the way in — never as though
  // the server derived it.
  reset();
  completionRow = makeCompletion();
  await run(ctrl.recordCheckpoint, makeReq({ body: { kind: "checkIn", lat: 50.4, lng: -104.6 } }), {
    middlewareOpts: { requireDraftCompletion: true },
  });
  assert.strictEqual(completionRow.checkIn.source, "client_reported");

  /* -------------- 10) The empty view has the SAME SHAPE ---------------- */
  // A short object here rendered "Photos (0/)" in the portal: no tsconfig means
  // a missing key is undefined at runtime, not a compile error.

  const empty = ctrl.buildVendorCompletionView(null);
  const populated = ctrl.buildVendorCompletionView({
    status: "draft",
    photos: [],
    report: {},
  });
  assert.deepStrictEqual(
    Object.keys(empty).sort(),
    Object.keys(populated).sort(),
    "the empty completion view must carry every key the populated one does"
  );
  assert.strictEqual(empty.maxPhotos, ctrl.MAX_COMPLETION_PHOTOS);

  /* -------------- 11) The vendor is never told the verdict ------------- */
  // It would be a roadmap for the next submission.

  reset();
  completionRow = makeCompletion({
    status: "in_review",
    evidenceVerdict: "review",
    evidenceReasons: ["checkin_geo_outside_radius"],
    report: { actualCost: 240, submittedAt: new Date() },
  });
  appointmentRow = makeAppointment({ status: "in_review" });
  const { res: view } = await run(ctrl.getCompletion, makeReq(), {
    middlewareOpts: { readOnly: true },
  });
  const serialized = JSON.stringify(view.body);
  assert.ok(!serialized.includes("geo_outside_radius"), "evidence reasons must not reach the vendor");
  assert.ok(!serialized.includes("evidenceVerdict"));

  reset(); appointmentRow.bookingVersion = 2;
  VendorOutreach.findOne = filter => {
    assert.strictEqual(filter.appointmentId, appointmentRow._id);
    assert.strictEqual(filter.landlordId, appointmentRow.landlordId);
    return { select: () => ({ lean: async () => ({ quoteContractVersion: 2 }) }) };
  };
  const fresh = await run(ctrl.getCompletion, makeReq(), { middlewareOpts: { readOnly: true } });
  assert.strictEqual(fresh.res.body.data.completion.quoteContractVersion, 2, "new itemized job advertises contract before its draft exists");
  assert.strictEqual(completionRow, null, "read-only GET does not create a completion draft");
  console.log("vendorCompletion.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
