// The beta clock and the founding agreement.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * "active" is decided by the DATE, never by the status flag, because the
//     flag lags the sweeper by up to an hour and the fee waiver rides on it;
//   * extending a lapsed beta counts from today, not from a date in the past;
//   * a landlord with no beta is "not in a beta", not an error;
//   * the agreement's numbers come from config and are what gets snapshotted,
//     and an unset rate promises notice rather than inventing a number.

const assert = require("assert");
const env = require("../../../config/env");

const DAY = 24 * 60 * 60 * 1000;

function main() {
  const {
    resolveBetaDays,
    buildBetaStamp,
    isBetaActive,
    betaDaysLeft,
    extendBeta,
    setBetaEnd,
    buildBetaView,
    isOfferOpen,
  } = require("../../../services/beta/beta.service");
  const cfg = require("../../../config/beta");

  const now = new Date("2026-10-09T12:00:00.000Z");

  /* -------- 0) The default length is a product decision ------------------ */
  // Pinned on purpose: this is how long every beta landlord is free, and so how
  // long Artrelo absorbs their costs. Changing it should be a deliberate edit
  // here, not a side effect.
  assert.strictEqual(cfg.DEFAULT_BETA_DAYS, 60);

  /* -------- 1) Days are validated --------------------------------------- */
  assert.strictEqual(resolveBetaDays(undefined), cfg.defaultBetaDays());
  assert.strictEqual(resolveBetaDays(null), cfg.defaultBetaDays());
  assert.strictEqual(resolveBetaDays("90"), 90, "a CLI string is accepted");
  for (const bad of [0, -1, 1.5, "abc", 731, NaN]) {
    assert.throws(() => resolveBetaDays(bad), /beta days/, `${bad} must be refused`);
  }

  /* -------- 2) The stamp ------------------------------------------------ */
  const stamp = buildBetaStamp(90, now);
  assert.strictEqual(stamp.status, "active");
  assert.strictEqual(stamp.startedAt.getTime(), now.getTime());
  assert.strictEqual(stamp.endsAt.getTime(), now.getTime() + 90 * DAY);
  assert.deepStrictEqual(stamp.remindersSent, []);

  /* -------- 3) Active is the date, not the flag ------------------------- */
  assert.strictEqual(isBetaActive(stamp, now), true);
  assert.strictEqual(isBetaActive(stamp, new Date(stamp.endsAt.getTime() - 1)), true);
  assert.strictEqual(isBetaActive(stamp, stamp.endsAt), false, "at the instant it ends, it has ended");
  // The sweeper has not run yet: the flag still says active, the date says no.
  assert.strictEqual(isBetaActive({ ...stamp, status: "active" }, new Date(stamp.endsAt.getTime() + 60_000)), false);
  assert.strictEqual(isBetaActive(undefined, now), false, "no beta -> not in one");
  assert.strictEqual(isBetaActive({}, now), false);

  /* -------- 4) Days left round UP, and floor at 0 ----------------------- */
  assert.strictEqual(betaDaysLeft(stamp, now), 90);
  assert.strictEqual(betaDaysLeft(stamp, new Date(stamp.endsAt.getTime() - 3 * 3600_000)), 1, "3 hours left reads as 1 day");
  assert.strictEqual(betaDaysLeft(stamp, new Date(stamp.endsAt.getTime() + DAY)), 0);
  assert.strictEqual(betaDaysLeft(undefined, now), null);

  /* -------- 5) Extending ------------------------------------------------ */
  const live = { startedAt: new Date(now.getTime() - 10 * DAY), endsAt: new Date(now.getTime() + 20 * DAY), remindersSent: ["30d"] };
  const longer = extendBeta(live, 30, { now });
  assert.strictEqual(longer.endsAt.getTime(), live.endsAt.getTime() + 30 * DAY, "from the current end when it is still ahead");
  assert.strictEqual(longer.startedAt.getTime(), live.startedAt.getTime(), "the start never moves");
  assert.deepStrictEqual(longer.remindersSent, [], "the new window gets its own reminders");
  assert.strictEqual(longer.status, "active");

  const lapsed = { startedAt: new Date(now.getTime() - 200 * DAY), endsAt: new Date(now.getTime() - 30 * DAY), status: "ended" };
  const revived = extendBeta(lapsed, 14, { now });
  assert.strictEqual(revived.endsAt.getTime(), now.getTime() + 14 * DAY, "a lapsed beta counts from today");
  assert.strictEqual(revived.status, "active");

  const joined = new Date("2026-08-01T00:00:00.000Z");
  const given = extendBeta(undefined, 60, { now, createdAt: joined });
  assert.strictEqual(given.startedAt.getTime(), joined.getTime(), "a landlord with no beta starts at the day they joined");
  assert.strictEqual(given.endsAt.getTime(), now.getTime() + 60 * DAY);
  assert.throws(() => extendBeta(live, 0, { now }), /beta days/);

  /* -------- 6) Pinning the end ------------------------------------------ */
  const future = setBetaEnd(live, new Date("2026-12-31T23:59:59.999Z"), { now });
  assert.strictEqual(future.status, "active");
  const past = setBetaEnd(live, new Date("2026-10-01T00:00:00.000Z"), { now });
  assert.strictEqual(past.status, "ended", "a date in the past ends the beta");
  assert.throws(() => setBetaEnd(live, "not a date", { now }), /not a date/);

  /* -------- 7) The agreement -------------------------------------------- */
  const saved = {
    a: env.service_fee_founding_cents,
    b: env.service_fee_founding_percent,
    c: env.founding_plan_discount_percent,
  };
  try {
    env.service_fee_founding_cents = undefined;
    env.service_fee_founding_percent = undefined;
    env.founding_plan_discount_percent = undefined;
    const unset = cfg.currentAgreement();
    assert.deepStrictEqual(unset.terms, { serviceFee: { flatCents: 0, percent: 0 }, planDiscountPercent: 0 });
    const feeText = unset.sections.find((s) => s.heading === "The service fee").body;
    assert.ok(!/\$/.test(feeText), "no rate chosen -> no number is invented");
    assert.ok(/in advance/.test(feeText));

    env.service_fee_founding_cents = "400";
    env.service_fee_founding_percent = "1.5";
    env.founding_plan_discount_percent = "30";
    const set = cfg.currentAgreement();
    assert.deepStrictEqual(set.terms, { serviceFee: { flatCents: 400, percent: 1.5 }, planDiscountPercent: 30 });
    const setFee = set.sections.find((s) => s.heading === "The service fee").body;
    assert.ok(setFee.includes("$4.00 per completed job plus 1.5% of the job payout"), setFee);
    assert.ok(set.sections.some((s) => /30% off/.test(s.body)));
    assert.ok(set.version.startsWith(`${cfg.AGREEMENT_VERSION}:`));
    assert.strictEqual(cfg.currentAgreement().version, set.version, "stable for identical terms");
    assert.notStrictEqual(set.version, unset.version, "a different rate is a different version");

    // Nonsense falls back safely instead of promising a negative or huge fee.
    env.service_fee_founding_cents = "-5";
    env.service_fee_founding_percent = "9999";
    env.founding_plan_discount_percent = "abc";
    assert.deepStrictEqual(cfg.foundingTerms(), { serviceFee: { flatCents: 0, percent: 20 }, planDiscountPercent: 0 });

    // The two promises the agreement text makes about the end of the beta.
    const all = set.sections.map((s) => s.body).join(" ");
    assert.ok(all.includes(`${cfg.CHARGE_NOTICE_DAYS} days' notice`));
    assert.ok(/does not switch off/.test(all));
  } finally {
    env.service_fee_founding_cents = saved.a;
    env.service_fee_founding_percent = saved.b;
    env.founding_plan_discount_percent = saved.c;
  }

  /* -------- 8) The status view: founding is PERMANENT ------------------- */
  const agreement = cfg.currentAgreement();
  const liveBeta = { beta: { startedAt: new Date(now - 10 * DAY), endsAt: new Date(now.getTime() + 20 * DAY) } };
  const view = (extra) => buildBetaView({ ...liveBeta, ...extra }, { now, agreement });

  let v = view({});
  assert.deepStrictEqual([v.offer, v.founding, v.phase], ["pending", false, "prominent"], "open offer, end is close");
  assert.strictEqual(view({ beta: { ...liveBeta.beta, endsAt: new Date(now.getTime() + 90 * DAY) } }).phase, "quiet");

  const acceptedNow = { foundingAgreement: { version: agreement.version, acceptedAt: now, terms: agreement.terms } };
  v = view(acceptedNow);
  assert.deepStrictEqual([v.offer, v.founding, v.phase, v.agreementAccepted], ["accepted", true, "accepted", true]);
  assert.strictEqual(String(v.foundingSince), String(now));

  // The offer's numbers change (a new version). They are STILL a founding
  // landlord, and are not asked again: the version only guards the accept call.
  const old = { foundingAgreement: { version: "founding-2025-old", acceptedAt: now, terms: agreement.terms } };
  v = view(old);
  assert.deepStrictEqual([v.offer, v.founding, v.phase], ["accepted", true, "accepted"], "an older acceptance still counts");
  assert.strictEqual(v.acceptedVersion, "founding-2025-old", "and the version they accepted is still reported");

  // After the beta ends, founding is unchanged; the phase says the beta is over.
  const ended = { beta: { startedAt: new Date(now - 70 * DAY), endsAt: new Date(now - DAY) } };
  v = buildBetaView({ ...ended, ...acceptedNow }, { now, agreement });
  assert.deepStrictEqual([v.offer, v.founding, v.phase, v.active], ["accepted", true, "ended", false]);

  // Declined.
  v = view({ foundingAgreement: { declinedAt: now } });
  assert.deepStrictEqual([v.offer, v.founding, v.phase], ["declined", false, "declined"]);
  assert.strictEqual(String(v.declinedAt), String(now));
  assert.strictEqual(buildBetaView({ ...ended, foundingAgreement: { declinedAt: now } }, { now, agreement }).offer, "declined");

  // Accepted wins over a stray declinedAt (accepting replaces the subdocument, so
  // both should never coexist -- but a founding landlord must never lose the label).
  v = view({ foundingAgreement: { acceptedAt: now, declinedAt: new Date(now - DAY) } });
  assert.deepStrictEqual([v.offer, v.founding, v.declinedAt], ["accepted", true, null]);

  // No beta: no offer, no phase -- and no way to be "pending".
  v = buildBetaView({}, { now, agreement });
  assert.deepStrictEqual([v.offer, v.founding, v.phase, v.inBeta], ["none", false, "none", false]);
  assert.strictEqual(buildBetaView(null, { now, agreement }).offer, "none");
  assert.strictEqual(buildBetaView(undefined, { now }).agreement, null, "no agreement given -> none, not a crash");

  /* -------- 9) isOfferOpen ------------------------------------------------ */
  assert.strictEqual(isOfferOpen(liveBeta), true, "in a beta, unanswered");
  assert.strictEqual(isOfferOpen({ ...ended }), true, "still open after the beta ends: it can be claimed late");
  assert.strictEqual(isOfferOpen({ ...liveBeta, ...acceptedNow }), false);
  assert.strictEqual(isOfferOpen({ ...liveBeta, foundingAgreement: { declinedAt: now } }), false);
  assert.strictEqual(isOfferOpen({}), false, "no beta, no offer");
  assert.strictEqual(isOfferOpen(null), false);
  assert.strictEqual(isOfferOpen(undefined), false);
  // Independent of the CURRENT agreement: it is about what the landlord did.
  assert.strictEqual(isOfferOpen({ ...liveBeta, ...old }), false);

  console.log("beta.service tests passed");
}

main();
