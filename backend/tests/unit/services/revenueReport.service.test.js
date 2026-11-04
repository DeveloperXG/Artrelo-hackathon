// The revenue report: definitions pinned on fixtures.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * a fee's lost-race original and its reversal are not counted -- only the
//     `:owed` re-bill is, so a fee is never billed twice;
//   * "collected" is cash-equivalent (covered at the close + later top-ups); a
//     fee that is only owed has not earned anything, and Net is built on it;
//   * the Connect account fee is per VENDOR per MONTH, not per job;
//   * only transfers that reached Stripe cost anything: not offline payouts, not
//     ones parked at pending_onboarding, not failed ones;
//   * a card top-up charged MORE on top than Stripe kept earns nothing -- that
//     cushion is floored at 0 and never offsets a real shortfall elsewhere;
//   * a top-up with no recorded Stripe fee is counted, not guessed at;
//   * nonsense rate settings fall back to Stripe's published rates;
//   * a landlord who paid fees AND has external deposits is flagged for the sweep.

const assert = require("assert");
const r = require("../../../services/metrics/revenueReport.service");

const at = (iso) => new Date(iso);
const L1 = "landlord-1";
const L2 = "landlord-2";
const avail = (landlordId) => `landlord:${landlordId}:available`;
const owedAcct = (landlordId) => `landlord:${landlordId}:fees_owed`;

// A fee billed in full: `collected` from the wallet, the rest owed.
const feeEntry = ({ landlordId = L1, total, collected, createdAt, shortfall = false }) => ({
  type: "fee",
  landlordId,
  amountCents: total,
  shortfall,
  createdAt: at(createdAt),
  lines: [
    { account: "platform:fee", direction: "debit", amountCents: total },
    ...(collected > 0 ? [{ account: avail(landlordId), direction: "credit", amountCents: collected }] : []),
    ...(total - collected > 0 ? [{ account: owedAcct(landlordId), direction: "credit", amountCents: total - collected }] : []),
  ],
});
const settlement = ({ landlordId = L1, amount, createdAt }) => ({
  type: "fee_settlement",
  landlordId,
  amountCents: amount,
  createdAt: at(createdAt),
  lines: [],
});
const payout = ({ identityId, amount, createdAt, provider = "stripe_connect", providerStatus = "paid" }) => ({
  type: "payout",
  identityId,
  amountCents: amount,
  provider,
  providerStatus,
  createdAt: at(createdAt),
});
const deposit = ({ landlordId = L1, amount, createdAt, fundingSource = "stripe", card }) => ({
  type: "deposit",
  landlordId,
  amountCents: amount,
  fundingSource,
  card,
  createdAt: at(createdAt),
});

function main() {
  /* -------- 1) Rates -------------------------------------------------- */
  assert.deepStrictEqual(r.connectRates({}), { accountFeeCents: 200, payoutPercent: 0.25, payoutFixedCents: 25 }, "Stripe's published rates by default");
  assert.deepStrictEqual(
    r.connectRates({ connect_account_fee_cents: "150", connect_payout_fee_percent: "0.5", connect_payout_fee_fixed_cents: "30" }),
    { accountFeeCents: 150, payoutPercent: 0.5, payoutFixedCents: 30 },
    "overridable without a code change"
  );
  assert.deepStrictEqual(
    r.connectRates({ connect_account_fee_cents: "-5", connect_payout_fee_percent: "9999", connect_payout_fee_fixed_cents: "abc" }),
    r.DEFAULT_CONNECT_RATES,
    "nonsense falls back, never negative and never free"
  );

  /* -------- 2) Fees: billed, collected, owed --------------------------- */
  const fees = r.summarizeFeeEntries([
    feeEntry({ total: 815, collected: 815, createdAt: "2026-10-05" }), // fully covered
    feeEntry({ total: 815, collected: 300, createdAt: "2026-10-20" }), // $5.15 owed
    settlement({ amount: 515, createdAt: "2026-11-02" }), // paid by a later top-up
    // A lost race: the stranded original (shortfall) is skipped; the re-bill counts once.
    feeEntry({ total: 500, collected: 500, createdAt: "2026-10-25", shortfall: true }),
    feeEntry({ total: 500, collected: 0, createdAt: "2026-10-25" }),
  ]);
  assert.deepStrictEqual(fees.get("2026-10"), { billed: 815 + 815 + 500, collectedAtClose: 815 + 300 + 0, owedAtClose: 0 + 515 + 500 });
  assert.deepStrictEqual(fees.get("2026-11"), { settledLater: 515 });

  /* -------- 3) Waived in the beta -------------------------------------- */
  const records = r.summarizeFeeRecords([
    { ledger: { serviceFee: { listCents: 500, chargedCents: 0, waivedReason: "beta", decidedAt: at("2026-10-03") } } },
    { ledger: { serviceFee: { listCents: 500, chargedCents: 0, waivedReason: "beta", decidedAt: at("2026-10-09") } } },
    { ledger: { serviceFee: { listCents: 500, chargedCents: 500, waivedReason: null, decidedAt: at("2026-10-12") } } },
    { ledger: {} },
  ]);
  assert.deepStrictEqual(records.get("2026-10"), { waived: 1000, jobs: 3 }, "a charged fee is not 'waived'; no record is skipped");

  /* -------- 4) Connect cost: per vendor-month + per transfer ----------- */
  const rates = r.DEFAULT_CONNECT_RATES;
  const connect = r.estimateConnectCost(
    [
      payout({ identityId: "v1", amount: 31200, createdAt: "2026-10-05" }),
      payout({ identityId: "v1", amount: 10000, createdAt: "2026-10-18" }), // same vendor, same month
      payout({ identityId: "v2", amount: 20000, createdAt: "2026-10-20" }),
      payout({ identityId: "v1", amount: 5000, createdAt: "2026-11-03" }), // next month: the account fee again
      payout({ identityId: "v3", amount: 99900, createdAt: "2026-10-21", provider: "offline", providerStatus: "paid" }), // offline: no Stripe cost
      payout({ identityId: "v4", amount: 99900, createdAt: "2026-10-21", providerStatus: "pending_onboarding" }), // never sent
      payout({ identityId: "v5", amount: 99900, createdAt: "2026-10-21", providerStatus: "failed" }),
      { ...payout({ identityId: "v6", amount: 99900, createdAt: "2026-10-21" }), type: "hold" },
    ],
    rates
  );
  const oct = connect.get("2026-10");
  assert.strictEqual(oct.vendors, 2, "two vendors, however many jobs each");
  assert.strictEqual(oct.transfers, 3);
  assert.strictEqual(oct.accountFeesCents, 2 * 200, "$2 per vendor per month, not per job");
  // 0.25% of each + 25c per transfer: 78+25, 25+25, 50+25.
  assert.strictEqual(oct.payoutFeesCents, Math.round(31200 * 0.0025) + 25 + Math.round(10000 * 0.0025) + 25 + Math.round(20000 * 0.0025) + 25);
  assert.strictEqual(oct.costCents, oct.accountFeesCents + oct.payoutFeesCents);
  assert.strictEqual(connect.get("2026-11").accountFeesCents, 200, "the same vendor in a new month pays the account fee again");
  assert.strictEqual(connect.get("2026-11").vendors, 1);

  /* -------- 5) Card shortfall ------------------------------------------ */
  const cards = r.summarizeCardShortfall([
    deposit({ amount: 10000, createdAt: "2026-10-04", card: { processingFeeCents: 330, stripeFeeCents: 350 } }), // foreign card: 20c short
    deposit({ amount: 10000, createdAt: "2026-10-06", card: { processingFeeCents: 330, stripeFeeCents: 320 } }), // gross-up cushion: NOT a gain
    deposit({ amount: 10000, createdAt: "2026-10-08", card: { processingFeeCents: 330, stripeFeeCents: null } }), // unknown
    deposit({ amount: 10000, createdAt: "2026-10-09", card: undefined }), // pre-dates the field
    deposit({ amount: 10000, createdAt: "2026-10-10", fundingSource: "external" }), // not a card
  ]);
  assert.deepStrictEqual(cards.get("2026-10"), { deposits: 4, withoutFee: 2, shortfall: 20 }, "the 10c cushion does not offset the 20c shortfall");

  /* -------- 6) The whole month, and Net -------------------------------- */
  const report = r.summarizeRevenue({
    feeEntries: [feeEntry({ total: 815, collected: 815, createdAt: "2026-10-05" }), feeEntry({ total: 815, collected: 300, createdAt: "2026-10-20" }), settlement({ amount: 515, createdAt: "2026-11-02" })],
    completions: [{ ledger: { serviceFee: { listCents: 500, chargedCents: 0, waivedReason: "beta", decidedAt: at("2026-10-03") } } }],
    payouts: [payout({ identityId: "v1", amount: 31200, createdAt: "2026-10-05" })],
    deposits: [deposit({ amount: 10000, createdAt: "2026-10-04", card: { processingFeeCents: 330, stripeFeeCents: 350 } })],
    rates,
  });
  const o = report.byMonth["2026-10"];
  assert.strictEqual(o.feeBilledCents, 1630);
  assert.strictEqual(o.feeCollectedCents, 815 + 300, "collected = cash-equivalent, not billed");
  assert.strictEqual(o.feeOwedAtCloseCents, 515);
  assert.strictEqual(o.feeWaivedCents, 500);
  assert.strictEqual(o.connectCostCents, 200 + Math.round(31200 * 0.0025) + 25);
  assert.strictEqual(o.cardShortfallCents, 20);
  assert.strictEqual(o.netCents, o.feeCollectedCents - o.connectCostCents - o.cardShortfallCents);
  const nov = report.byMonth["2026-11"];
  assert.strictEqual(nov.feeCollectedCents, 515, "a later top-up paying the debt is revenue in the month it arrives");
  assert.strictEqual(nov.feeBilledCents, 0, "and it is not billed again");
  assert.strictEqual(report.total.feeBilledCents, 1630);
  assert.strictEqual(report.total.feeCollectedCents, 815 + 300 + 515);
  assert.strictEqual(report.total.netCents, o.netCents + nov.netCents);
  assert.deepStrictEqual(Object.keys(report.byMonth), ["2026-10", "2026-11"], "months in order");

  // Nothing at all.
  const empty = r.summarizeRevenue({});
  assert.deepStrictEqual(empty.byMonth, {});
  assert.strictEqual(empty.total.netCents, 0);

  /* -------- 7) The sweep check ------------------------------------------ */
  const landlords = r.summarizeLandlordFees({
    feeEntries: [
      feeEntry({ landlordId: L1, total: 815, collected: 815, createdAt: "2026-10-05" }),
      feeEntry({ landlordId: L2, total: 500, collected: 500, createdAt: "2026-10-06" }),
      feeEntry({ landlordId: "landlord-3", total: 500, collected: 0, createdAt: "2026-10-07" }), // only owed
      feeEntry({ landlordId: "landlord-4", total: 500, collected: 500, createdAt: "2026-10-07", shortfall: true }), // stranded, ignored
      settlement({ landlordId: L2, amount: 100, createdAt: "2026-10-30" }),
    ],
    deposits: [
      deposit({ landlordId: L1, amount: 50000, createdAt: "2026-10-01" }),
      deposit({ landlordId: L2, amount: 20000, createdAt: "2026-10-01" }),
      deposit({ landlordId: L2, amount: 30000, createdAt: "2026-10-02", fundingSource: "external" }),
    ],
    ledgers: [{ landlordId: "landlord-3", feesOwed: 500 }],
  });
  const byId = Object.fromEntries(landlords.map((l) => [l.landlordId, l]));
  assert.strictEqual(byId[L1].checkBeforeSweep, false, "fully card-funded: safe");
  assert.strictEqual(byId[L2].checkBeforeSweep, true, "paid fees from a wallet with external money: check first");
  assert.strictEqual(byId[L2].feeCollectedCents, 600);
  assert.strictEqual(byId["landlord-3"].feeOwedCents, 500);
  assert.strictEqual(byId["landlord-3"].checkBeforeSweep, false, "owing a fee is not paying one");
  assert.strictEqual(byId["landlord-4"], undefined, "a stranded lost-race entry is not a landlord who paid");
  assert.strictEqual(landlords[0].landlordId, L1, "largest fee payer first");

  const { summarizeDisputeCosts } = require("../../../services/metrics/revenueReport.service");
  const tx = { id: "txn_1", feeCents: 1500, amountCents: -10330, createdAt: new Date("2026-10-01") };
  assert.deepStrictEqual(summarizeDisputeCosts([{ transactions: [tx, tx] }, { transactions: [tx] }]), { "2026-10": 1500 });
  assert.deepStrictEqual(summarizeDisputeCosts([{ transactions: [tx] }], { from: new Date("2026-11-01") }), {});

  console.log("revenueReport.service tests passed");
}

main();
