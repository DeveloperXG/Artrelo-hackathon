// Giving existing users an Account.
//
// THE RULE THIS FILE EXISTS TO PROTECT: the same address in both collections
// becomes ONE account, and when those two rows had different passwords the
// merge is reported rather than silently picking one. That case is the whole
// reason accounts exist, so the migration has to face it head on.

const assert = require("assert");
const { planBackfill } = require("../../../scripts/backfill_accounts");

const landlord = (email, hash, extra = {}) => ({ _id: `l-${email}`, email, hashedPassword: hash, ...extra });
const tenant = (email, hash, extra = {}) => ({ _id: `t-${email}`, email, hashedPassword: hash, ...extra });

function main() {
  /* -------------- 1) One profile per address --------------------------- */

  let plan = planBackfill([landlord("dana@x.com", "h1")], [tenant("sam@x.com", "h2")]);
  assert.strictEqual(plan.accounts.length, 2);
  assert.strictEqual(plan.assignments.length, 2);
  assert.strictEqual(plan.warnings.length, 0);

  /* -------------- 2) Addresses are canonicalised first ----------------- */

  plan = planBackfill([landlord("  Dana@X.com ", "h1")], [tenant("dana@x.com", "h1")]);
  assert.strictEqual(plan.accounts.length, 1, "case and padding must not split one person in two");
  assert.strictEqual(plan.accounts[0].email, "dana@x.com");
  assert.strictEqual(plan.assignments.length, 2, "both profiles point at that one account");
  assert.ok(plan.warnings.some((w) => /same password/.test(w)), "the merge is still reported");

  /* -------------- 3) Both roles, different passwords ------------------- */

  plan = planBackfill([landlord("dana@x.com", "landlord-hash")], [tenant("dana@x.com", "tenant-hash")]);
  assert.strictEqual(plan.accounts.length, 1);
  assert.strictEqual(
    plan.accounts[0].hashedPassword,
    "landlord-hash",
    "the landlord password is kept — that is the account that owns data"
  );
  assert.ok(
    plan.warnings.some((w) => /DIFFERENT passwords/.test(w) && /reset/.test(w)),
    "and the other role is told to reset"
  );

  /* -------------- 4) Order does not decide the winner ------------------ */
  //
  // The tenant is seen first here; the landlord's password must still win.

  plan = planBackfill([landlord("dana@x.com", "landlord-hash")], [tenant("dana@x.com", "tenant-hash")]);
  const first = plan.accounts[0].hashedPassword;
  plan = planBackfill([], [tenant("dana@x.com", "tenant-hash")]);
  assert.strictEqual(plan.accounts[0].hashedPassword, "tenant-hash", "a tenant alone keeps their own");
  assert.strictEqual(first, "landlord-hash");

  /* -------------- 5) Re-running skips what is already done ------------- */

  plan = planBackfill([landlord("done@x.com", "h", { accountId: "acc-1" })], []);
  assert.strictEqual(plan.accounts.length, 0);
  assert.strictEqual(plan.assignments.length, 0);
  assert.strictEqual(plan.skipped.length, 1, "the script must be safe to run twice");

  /* -------------- 6) Unusable rows are reported, not guessed at -------- */

  plan = planBackfill(
    [landlord("", "h"), landlord("nopass@x.com", undefined)],
    [tenant("fine@x.com", "h")]
  );
  assert.strictEqual(plan.accounts.length, 1, "only the usable row becomes an account");
  assert.strictEqual(plan.warnings.length, 2);
  assert.ok(plan.warnings.some((w) => /no email/.test(w)));
  assert.ok(plan.warnings.some((w) => /no password hash/.test(w)));

  /* -------------- 7) An empty database plans nothing ------------------- */

  plan = planBackfill([], []);
  assert.deepStrictEqual(
    { a: plan.accounts.length, b: plan.assignments.length, c: plan.warnings.length },
    { a: 0, b: 0, c: 0 },
    "production has no users; the script must be a no-op there"
  );

  console.log("backfillAccounts tests passed");
}

main();
