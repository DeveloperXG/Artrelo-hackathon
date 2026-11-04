// The service fee's QUOTE: how much, at which rate, and whether it is waived.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * flat + percentage of the payout, rounded to the cent, never more than the
//     job itself;
//   * a founding landlord's LOCKED snapshot is used verbatim and never re-read
//     from the environment;
//   * a founding snapshot of 0/0 means "not set yet", not "free forever";
//   * waived while the beta runs -- decided by the DATE at the close, never by
//     beta.status, which lags the sweeper;
//   * nonsense settings degrade safely (never negative, percent clamped);
//   * the Wallet's fee line names the rate that would ACTUALLY be charged, and
//     never quotes the list rate to a founding landlord as if it were theirs.

const assert = require("assert");
const env = require("../../../config/env");
const { quoteServiceFee, feeFor, resolveRate, listTerms, buildServiceFeeLine } = require("../../../services/ledger/serviceFee");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-10T12:00:00.000Z");
const inBeta = { beta: { status: "active", startedAt: new Date(NOW - 10 * DAY), endsAt: new Date(+NOW + 10 * DAY) } };
const afterBeta = { beta: { status: "active", startedAt: new Date(NOW - 70 * DAY), endsAt: new Date(NOW - DAY) } };

function withEnv(values, fn) {
  const keys = ["service_fee_cents", "service_fee_percent", "service_fee_founding_cents", "service_fee_founding_percent"];
  const saved = Object.fromEntries(keys.map((k) => [k, env[k]]));
  try {
    for (const k of keys) env[k] = values[k];
    return fn();
  } finally {
    Object.assign(env, saved);
  }
}

function main() {
  /* -------- 1) The arithmetic ------------------------------------------- */
  assert.strictEqual(feeFor({ flatCents: 500, percent: 0 }, 31200), 500);
  assert.strictEqual(feeFor({ flatCents: 0, percent: 1.5 }, 31200), 468);
  assert.strictEqual(feeFor({ flatCents: 400, percent: 1.5 }, 31200), 868);
  assert.strictEqual(feeFor({ flatCents: 0, percent: 2.5 }, 101), 3, "rounded to the nearest cent (2.525 -> 3)");
  assert.strictEqual(feeFor({ flatCents: 500, percent: 0 }, 300), 300, "never more than the job itself");
  assert.strictEqual(feeFor({ flatCents: 500, percent: 0 }, 0), 0, "no job, no fee");
  assert.strictEqual(feeFor({ flatCents: 500, percent: 0 }, 12.5), 0, "non-integer cents are refused, not guessed at");

  /* -------- 2) Nothing configured -> no fee ------------------------------ */
  withEnv({}, () => {
    const q = quoteServiceFee({ landlord: afterBeta, payoutCents: 31200, at: NOW });
    assert.deepStrictEqual([q.listCents, q.chargeCents, q.waivedReason], [0, 0, null]);
  });

  /* -------- 3) List rate, after the beta: charged ----------------------- */
  withEnv({ service_fee_cents: "500" }, () => {
    const q = quoteServiceFee({ landlord: afterBeta, payoutCents: 31200, at: NOW });
    assert.deepStrictEqual(
      { list: q.listCents, charge: q.chargeCents, waived: q.waivedReason, source: q.rateSource },
      { list: 500, charge: 500, waived: null, source: "list" }
    );

    // A landlord with no beta at all (predates the program) is not in one.
    assert.strictEqual(quoteServiceFee({ landlord: {}, payoutCents: 31200, at: NOW }).chargeCents, 500);
    assert.strictEqual(quoteServiceFee({ landlord: null, payoutCents: 31200, at: NOW }).chargeCents, 500);
  });

  /* -------- 4) Waived during the beta, by DATE -------------------------- */
  withEnv({ service_fee_cents: "500" }, () => {
    const q = quoteServiceFee({ landlord: inBeta, payoutCents: 31200, at: NOW });
    assert.deepStrictEqual([q.listCents, q.chargeCents, q.waivedReason], [500, 0, "beta"]);

    // The sweeper has not flipped the status yet, but the date has passed.
    const stale = { beta: { ...afterBeta.beta, status: "active" } };
    assert.strictEqual(quoteServiceFee({ landlord: stale, payoutCents: 31200, at: NOW }).chargeCents, 500);

    // Decided as of `at` -- the moment the job closed -- not the moment of the call.
    const justBeforeEnd = new Date(afterBeta.beta.endsAt.getTime() - 1000);
    assert.strictEqual(quoteServiceFee({ landlord: afterBeta, payoutCents: 31200, at: justBeforeEnd }).waivedReason, "beta");
  });

  /* -------- 5) Founding rates ------------------------------------------- */
  withEnv({ service_fee_cents: "900", service_fee_founding_cents: "400", service_fee_founding_percent: "1" }, () => {
    const locked = {
      ...afterBeta,
      foundingAgreement: { acceptedAt: NOW, version: "v", terms: { serviceFee: { flatCents: 300, percent: 0 } } },
    };
    let q = quoteServiceFee({ landlord: locked, payoutCents: 31200, at: NOW });
    assert.strictEqual(q.rateSource, "founding_locked");
    assert.strictEqual(q.chargeCents, 300, "the LOCKED snapshot wins over today's founding and list rates");

    const notYetSet = {
      ...afterBeta,
      foundingAgreement: { acceptedAt: NOW, version: "v", terms: { serviceFee: { flatCents: 0, percent: 0 } } },
    };
    q = quoteServiceFee({ landlord: notYetSet, payoutCents: 31200, at: NOW });
    assert.strictEqual(q.rateSource, "founding", "a 0/0 snapshot means 'not set yet'");
    assert.strictEqual(q.chargeCents, 400 + 312);

    // Never accepted -> list rate, whatever a founding rate might be.
    assert.strictEqual(quoteServiceFee({ landlord: afterBeta, payoutCents: 31200, at: NOW }).chargeCents, 900);
    // An unaccepted agreement object (no acceptedAt) is not a founding landlord.
    const unaccepted = { ...afterBeta, foundingAgreement: { terms: { serviceFee: { flatCents: 1, percent: 0 } } } };
    assert.strictEqual(resolveRate(unaccepted).source, "list");
  });

  withEnv({ service_fee_cents: "900" }, () => {
    // Founding rate unset and snapshot 0/0: falls through to the list rate.
    const notYetSet = {
      ...afterBeta,
      foundingAgreement: { acceptedAt: NOW, terms: { serviceFee: { flatCents: 0, percent: 0 } } },
    };
    assert.strictEqual(resolveRate(notYetSet).source, "list");
  });

  /* -------- 6) Nonsense settings degrade safely ------------------------- */
  withEnv({ service_fee_cents: "-200", service_fee_percent: "9999" }, () => {
    assert.deepStrictEqual(listTerms(), { flatCents: 0, percent: 20 }, "negative -> 0, huge percent -> clamped to 20");
  });
  withEnv({ service_fee_cents: "abc", service_fee_percent: "" }, () => {
    assert.deepStrictEqual(listTerms(), { flatCents: 0, percent: 0 });
  });

  /* -------- 7) The Wallet's fee line ------------------------------------ */
  const line = (landlord) => buildServiceFeeLine(landlord, NOW);
  const acceptedAt = NOW;
  const foundingWith = (base, flatCents, percent = 0) => ({
    ...base,
    foundingAgreement: { acceptedAt, terms: { serviceFee: { flatCents, percent } } },
  });
  const declined = (base) => ({ ...base, foundingAgreement: { declinedAt: NOW } });

  withEnv({ service_fee_cents: "500", service_fee_founding_cents: "400", service_fee_founding_percent: "1.5" }, () => {
    // In the beta: waived, with the end date and what comes after.
    let l = line(inBeta);
    assert.strictEqual(l.kind, "waived");
    assert.strictEqual(+l.waivedUntil, +inBeta.beta.endsAt);
    assert.strictEqual(l.rate.description, "$5.00 per completed job", "an ordinary landlord: the list rate afterwards");
    assert.strictEqual(l.foundingRate, false);

    l = line(foundingWith(inBeta, 400, 1.5));
    assert.strictEqual(l.kind, "waived");
    assert.strictEqual(l.rate.description, "$4.00 per completed job plus 1.5% of the job payout");
    assert.deepStrictEqual([l.founding, l.foundingRate, l.locked], [true, true, true]);

    // Accepted at 0/0: the CURRENT founding rate floats until the first charge.
    l = line(foundingWith(inBeta, 0, 0));
    assert.deepStrictEqual([l.foundingRate, l.locked], [true, false]);
    assert.strictEqual(l.rate.description, "$4.00 per completed job plus 1.5% of the job payout");

    // A decliner is an ordinary landlord for the fee.
    l = line(declined(inBeta));
    assert.deepStrictEqual([l.kind, l.founding, l.rate.description], ["waived", false, "$5.00 per completed job"]);

    // After the beta.
    assert.deepStrictEqual(
      [line(afterBeta).kind, line(afterBeta).rate.description],
      ["list", "$5.00 per completed job"]
    );
    l = line(foundingWith(afterBeta, 400, 1.5));
    assert.deepStrictEqual([l.kind, l.locked, l.waivedUntil], ["founding", true, null]);
    l = line(foundingWith(afterBeta, 0, 0));
    assert.deepStrictEqual([l.kind, l.locked], ["founding", false], "floating founding rate is founding, not locked");
    assert.strictEqual(line(declined(afterBeta)).kind, "list");

    // No beta at all (an account created before betas existed): just the fee.
    assert.strictEqual(line({}).kind, "list");
    assert.strictEqual(line(null).kind, "list", "a missing landlord degrades to the list wording");
  });

  withEnv({ service_fee_cents: "900" }, () => {
    // Founding, but no founding rate configured: in the beta, say "confirmed
    // later" (rate null) -- never the list rate dressed as theirs.
    const l = line(foundingWith(inBeta, 0, 0));
    assert.deepStrictEqual([l.kind, l.rate, l.founding, l.foundingRate], ["waived", null, true, false]);
    // After the beta that is what they are actually charged, so say it plainly.
    const after = line(foundingWith(afterBeta, 0, 0));
    assert.deepStrictEqual([after.kind, after.rate.description], ["list", "$9.00 per completed job"]);
  });

  withEnv({}, () => {
    // No fee configured anywhere.
    const l = line(inBeta);
    assert.deepStrictEqual([l.kind, l.rate], ["waived", null], "still waived, nothing after to name");
    assert.strictEqual(line(afterBeta), null, "beta over and no fee: nothing true to say");
    assert.strictEqual(line(foundingWith(afterBeta, 0, 0)), null);
  });

  console.log("serviceFee quote tests passed");
}

main();
