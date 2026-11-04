const assert = require("node:assert/strict");
const {
  summarizeOutreach,
} = require("../../../services/request/outreachSummary.service");

const createdAt = "2026-10-20T21:51:27.100Z";
const sentAt = "2026-10-20T21:51:27.200Z";
const respondedAt = "2026-10-22T00:49:08.000Z";
const updatedAt = "2026-10-22T00:49:11.000Z";
const base = {
  _id: "attempt-one",
  vendorNameSnapshot: "Test Vendor",
  createdAt,
  sentAt,
  respondedAt,
  updatedAt,
};

for (const status of ["accepted", "declined"]) {
  const summary = summarizeOutreach({ ...base, status });
  assert.equal(summary.state, "responded");
  assert.equal(summary.responseStatus, status);
  assert.equal(
    summary.eventAt,
    respondedAt,
    "later bookkeeping must not move an old vendor reply",
  );
}
for (const status of ["expired", "revoked", "superseded"]) {
  const summary = summarizeOutreach({ ...base, status });
  assert.equal(
    summary.state,
    "closed",
    "system closure is not a vendor response",
  );
  assert.equal(summary.responseStatus, status);
  assert.equal(summary.eventAt, updatedAt);
}
for (const status of ["sent", "viewed"]) {
  assert.equal(summarizeOutreach({ ...base, status }).eventAt, sentAt);
}
for (const status of ["queued", "scheduled"]) {
  const summary = summarizeOutreach({
    ...base,
    status,
    scheduledFor: "2026-12-01T09:00:00Z",
  });
  assert.equal(
    summary.eventAt,
    createdAt,
    "future delivery schedule is not an activity timestamp",
  );
}
assert.equal(
  summarizeOutreach({ ...base, status: "delivery_failed" }).eventAt,
  updatedAt,
);
assert.equal(
  summarizeOutreach({
    ...base,
    status: "delivery_failed",
    deliveryUnconfirmed: true,
  }).state,
  "unconfirmed",
);
assert.equal(
  summarizeOutreach({ ...base, status: "accepted", respondedAt: "invalid" })
    .eventAt,
  updatedAt,
);
assert.equal(
  summarizeOutreach({ _id: "legacy", status: "declined" }).eventAt,
  null,
);
assert.equal(
  summarizeOutreach({
    _id: "legacy",
    status: "scheduled",
    scheduledFor: updatedAt,
  }).eventAt,
  null,
);
assert.equal(summarizeOutreach(null), null);
console.log("outreach summary occurrence-time and closed-outcome tests passed");
