// Artrelo's unit economics: what the service fee earned, and what Artrelo paid
// Stripe to earn it. Read-only.
//
// SHAPE, as in betaMetrics.service: loaders read, the summarize*/estimate*
// functions are pure and take plain arrays, so the arithmetic is tested without
// a database. All money is integer cents.
//
// THE DEFINITIONS, written down where the code cannot drift from them:
//
//   Fee billed        every `fee` journal entry that is not a stranded
//                     lost-race original (shortfall: true). That includes the
//                     `fee:<id>:owed` re-bill, whose original and reversal net
//                     to zero. Billed = collected at the close + owed at the
//                     close.
//
//   Fee collected     CASH-equivalent: the part of a fee the wallet covered at
//                     the close, plus later top-ups paying fee debt down
//                     (fee_settlement). This is what Net is built on -- a fee
//                     that is only owed has not earned anything yet.
//
//   Waived (beta)     the list fee on jobs closed during a landlord's beta:
//                     what the beta WOULD have earned. For the founding-offer
//                     conversation, and for sizing the rate.
//
//   Connect cost      an ESTIMATE, and an upper bound until Phase 0 confirms
//                     the real schedule: $2 per vendor per month in which that
//                     vendor was sent a transfer, plus 0.25% + $0.25 per
//                     transfer (as if every transfer were its own bank payout,
//                     i.e. daily payouts). Rates are settings, not constants --
//                     the first live payout will correct them.
//
//   Card shortfall    what Stripe kept on a card top-up beyond what the
//                     landlord was charged on top (foreign cards cost more
//                     than the domestic rate the gross-up covers). Absorbed by
//                     Artrelo. Deposits with no recorded Stripe fee are
//                     counted and reported, not guessed at.
//
//   Bank fees         Artrelo ABSORBS Stripe's fee on a bank top-up (1% +
//   absorbed          $0.40, capped at $5) -- the landlord pays nothing on top.
//                     Read off each settled bank deposit (bank.stripeFeeCents),
//                     plus an ESTIMATE of the one-time verification fee per
//                     new bank account (bank_verification_fee_cents). Deposits
//                     with no recorded fee are counted, not guessed at.
//
//   Bank fees         failure and dispute fees charged to landlords
//   recovered         (platform:bank_fees), what they paid of them: the part
//                     the wallet covered, plus later top-ups paying bank_owed.
//                     Approximate on the repayment side: bank_owed also holds
//                     reversed deposits, and a repayment is not split between
//                     the two. It only RECOVERS what Stripe charged Artrelo,
//                     which is why it is not in "fee collected".
//
//   Net               fee collected - Connect cost - card shortfall - bank fees
//                     absorbed + bank fees recovered. OpenAI is excluded until
//                     it is measured.
//
// SWEEPING FEES TO THE "ARTRELO" ACCOUNT. Fee revenue sits in the Artrelo
// Wallets platform balance, tracked by the platform:fee ledger account. A fee
// taken from a wallet funded by an EXTERNAL deposit (a wire the landlord says
// they sent) matches no money actually in Stripe. perLandlord flags every
// landlord who both paid fees and has external deposits: check those before
// moving money.

const LedgerEntry = require("../../models/LedgerEntry");
const WalletTopUp = require("../../models/WalletTopUp");
const FundingDispute = require("../../models/FundingDispute");
const { bankDebitSettings } = require("../ledger/bankDebitSettings");
const LandlordLedger = require("../../models/LandlordLedger");
const JobCompletion = require("../../models/JobCompletion");
const env = require("../../config/env");

const monthKey = (date) => new Date(date).toISOString().slice(0, 7);
const idOf = (value) => (value === null || value === undefined ? "" : String(value));
const sortedObject = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));

// Stripe's published Connect rates in CAD, as of 2026-10: the account fee is
// per vendor per month with a payout, the payout fee is per bank payout.
const DEFAULT_CONNECT_RATES = { accountFeeCents: 200, payoutPercent: 0.25, payoutFixedCents: 25 };

function numberOr(value, fallback, { min = 0, max = Infinity, integer = false } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  if (integer && !Number.isSafeInteger(n)) return fallback;
  return n;
}

/** Connect rates from the environment; anything missing or nonsense falls back to the default. */
function connectRates(source = env) {
  return {
    accountFeeCents: numberOr(source.connect_account_fee_cents, DEFAULT_CONNECT_RATES.accountFeeCents, { max: 10000, integer: true }),
    payoutPercent: numberOr(source.connect_payout_fee_percent, DEFAULT_CONNECT_RATES.payoutPercent, { max: 10 }),
    payoutFixedCents: numberOr(source.connect_payout_fee_fixed_cents, DEFAULT_CONNECT_RATES.payoutFixedCents, { max: 1000, integer: true }),
  };
}

const sumLines = (entry, suffix, direction) =>
  (entry.lines || [])
    .filter((line) => String(line.account || "").endsWith(suffix) && line.direction === direction)
    .reduce((total, line) => total + (Number(line.amountCents) || 0), 0);

function emptyMonth() {
  return {
    feeBilledCents: 0,
    feeCollectedAtCloseCents: 0,
    feeOwedAtCloseCents: 0,
    feeSettledLaterCents: 0,
    feeCollectedCents: 0,
    feeWaivedCents: 0,
    feeJobs: 0,
    connectVendors: 0,
    connectTransfers: 0,
    connectVolumeCents: 0,
    connectAccountFeesCents: 0,
    connectPayoutFeesCents: 0,
    connectCostCents: 0,
    cardDeposits: 0,
    cardDepositsWithoutFee: 0,
    cardShortfallCents: 0,
    bankDeposits: 0,
    bankDepositsWithoutFee: 0,
    bankFeesAbsorbedCents: 0,
    bankVerificationsEstimated: 0,
    bankVerificationCostCents: 0,
    bankFeesChargedCents: 0,
    bankFeesRecoveredCents: 0,
    netCents: 0,
  };
}

/**
 * Fee entries -> billed / collected / owed per month.
 *
 * A stranded lost-race original (shortfall) is skipped: it was reversed and
 * re-billed under `fee:<id>:owed`, so counting it would bill the fee twice.
 */
function summarizeFeeEntries(entries = []) {
  const byMonth = new Map();
  const bump = (month, field, cents) => {
    if (!byMonth.has(month)) byMonth.set(month, {});
    byMonth.get(month)[field] = (byMonth.get(month)[field] || 0) + cents;
  };

  for (const entry of entries) {
    const month = monthKey(entry.createdAt);
    if (entry.type === "fee" && !entry.shortfall) {
      bump(month, "billed", entry.amountCents || 0);
      bump(month, "collectedAtClose", sumLines(entry, ":available", "credit"));
      bump(month, "owedAtClose", sumLines(entry, ":fees_owed", "credit"));
    } else if (entry.type === "fee_settlement") {
      bump(month, "settledLater", entry.amountCents || 0);
    }
  }
  return byMonth;
}

/** Waived fee decisions recorded on completions, per month decided. */
function summarizeFeeRecords(completions = []) {
  const byMonth = new Map();
  for (const completion of completions) {
    const fee = completion?.ledger?.serviceFee;
    if (!fee?.decidedAt) continue;
    const month = monthKey(fee.decidedAt);
    if (!byMonth.has(month)) byMonth.set(month, { waived: 0, jobs: 0 });
    const row = byMonth.get(month);
    row.jobs += 1;
    // What the beta would have earned: the list fee on a job whose fee was waived.
    if (fee.waivedReason) row.waived += (Number(fee.listCents) || 0) - (Number(fee.chargedCents) || 0);
  }
  return byMonth;
}

/**
 * Stripe's cost of the transfers Artrelo sent, per month. An estimate (see the
 * header). Only transfers that actually reached Stripe count: provider
 * stripe_connect and status paid. An offline payout, or one parked at
 * pending_onboarding, cost Stripe nothing.
 */
function estimateConnectCost(payouts = [], rates = connectRates()) {
  const byMonth = new Map();
  for (const payout of payouts) {
    if (payout.type !== "payout" || payout.provider !== "stripe_connect" || payout.providerStatus !== "paid") continue;
    const month = monthKey(payout.createdAt);
    if (!byMonth.has(month)) byMonth.set(month, { vendors: new Set(), transfers: 0, volume: 0, payoutFees: 0 });
    const row = byMonth.get(month);
    const cents = Number(payout.amountCents) || 0;
    row.vendors.add(idOf(payout.identityId) || `unknown:${idOf(payout._id)}`);
    row.transfers += 1;
    row.volume += cents;
    // Per transfer: the percentage on the amount plus the fixed part.
    row.payoutFees += Math.round((cents * rates.payoutPercent) / 100) + rates.payoutFixedCents;
  }

  const out = new Map();
  for (const [month, row] of byMonth) {
    const accountFees = row.vendors.size * rates.accountFeeCents;
    out.set(month, {
      vendors: row.vendors.size,
      transfers: row.transfers,
      volumeCents: row.volume,
      accountFeesCents: accountFees,
      payoutFeesCents: row.payoutFees,
      costCents: accountFees + row.payoutFees,
    });
  }
  return out;
}

/**
 * What Stripe kept on card top-ups beyond what landlords were charged on top.
 * Positive = Artrelo absorbed it. Only settled card deposits that recorded
 * Stripe's real fee can say; the rest are counted, not guessed.
 */
function summarizeCardShortfall(deposits = []) {
  const byMonth = new Map();
  for (const deposit of deposits) {
    if (deposit.type !== "deposit" || deposit.fundingSource !== "stripe") continue;
    const month = monthKey(deposit.createdAt);
    if (!byMonth.has(month)) byMonth.set(month, { deposits: 0, withoutFee: 0, shortfall: 0 });
    const row = byMonth.get(month);
    row.deposits += 1;
    const stripeFee = deposit.card?.stripeFeeCents;
    if (!Number.isSafeInteger(stripeFee)) {
      row.withoutFee += 1;
      continue;
    }
    // Floored at 0: a landlord who was charged MORE on top than Stripe kept
    // (the gross-up rounds up) did not earn Artrelo anything -- that cushion
    // is not revenue, and netting it would hide real shortfalls on other cards.
    row.shortfall += Math.max(0, stripeFee - (Number(deposit.card?.processingFeeCents) || 0));
  }
  return byMonth;
}

/**
 * Bank top-ups' Stripe cost, absorbed by Artrelo, and the failure/dispute fees
 * recovered from landlords. `firstBankTopUps` is one date per landlord: their
 * first bank top-up that reached the bank, i.e. a new account verified.
 */
function summarizeBankFees({ deposits = [], bankFeeEntries = [], firstBankTopUps = [], verificationFeeCents = 0 } = {}) {
  const byMonth = new Map();
  const row = (month) => {
    if (!byMonth.has(month)) {
      byMonth.set(month, { deposits: 0, withoutFee: 0, absorbed: 0, verifications: 0, charged: 0, recovered: 0 });
    }
    return byMonth.get(month);
  };

  for (const deposit of deposits) {
    if (deposit.type !== "deposit" || deposit.fundingSource !== "stripe" || deposit.memo !== "Bank top-up") continue;
    const r = row(monthKey(deposit.createdAt));
    r.deposits += 1;
    const fee = deposit.bank?.stripeFeeCents;
    if (Number.isSafeInteger(fee)) r.absorbed += fee;
    else r.withoutFee += 1;
  }
  for (const at of firstBankTopUps) row(monthKey(at)).verifications += 1;
  for (const entry of bankFeeEntries) {
    const r = row(monthKey(entry.createdAt));
    if (entry.type === "bank_fee" && !entry.shortfall) {
      r.charged += entry.amountCents || 0;
      r.recovered += sumLines(entry, ":available", "credit");
    } else if (entry.type === "bank_settlement") {
      // Repayment of bank_owed. bank_owed also holds reversed deposits (the
      // landlord's own money coming back, not revenue), so summarizeRevenue
      // caps recovery at what was charged in the same month. That can only
      // UNDERSTATE recovery (a fee repaid a month later), never invent it.
      r.recovered += entry.amountCents || 0;
    }
  }

  const out = new Map();
  for (const [month, r] of byMonth) {
    out.set(month, { ...r, verificationCost: r.verifications * verificationFeeCents });
  }
  return out;
}

/**
 * Merge every source into one row per month, plus totals.
 * `inputs` = { feeEntries, completions, payouts, deposits, rates }.
 */
function summarizeRevenue({
  feeEntries = [],
  completions = [],
  payouts = [],
  deposits = [],
  bankFeeEntries = [],
  firstBankTopUps = [],
  verificationFeeCents = 0,
  rates = connectRates(),
} = {}) {
  const fees = summarizeFeeEntries(feeEntries);
  const records = summarizeFeeRecords(completions);
  const connect = estimateConnectCost(payouts, rates);
  const cards = summarizeCardShortfall(deposits);
  const banks = summarizeBankFees({ deposits, bankFeeEntries, firstBankTopUps, verificationFeeCents });

  const months = new Set([...fees.keys(), ...records.keys(), ...connect.keys(), ...cards.keys(), ...banks.keys()]);
  const byMonth = {};
  const total = emptyMonth();

  for (const month of [...months].sort()) {
    const row = emptyMonth();
    const f = fees.get(month) || {};
    const r = records.get(month) || {};
    const c = connect.get(month) || {};
    const k = cards.get(month) || {};
    const b = banks.get(month) || {};

    row.feeBilledCents = f.billed || 0;
    row.feeCollectedAtCloseCents = f.collectedAtClose || 0;
    row.feeOwedAtCloseCents = f.owedAtClose || 0;
    row.feeSettledLaterCents = f.settledLater || 0;
    row.feeCollectedCents = row.feeCollectedAtCloseCents + row.feeSettledLaterCents;
    row.feeWaivedCents = r.waived || 0;
    row.feeJobs = r.jobs || 0;
    row.connectVendors = c.vendors || 0;
    row.connectTransfers = c.transfers || 0;
    row.connectVolumeCents = c.volumeCents || 0;
    row.connectAccountFeesCents = c.accountFeesCents || 0;
    row.connectPayoutFeesCents = c.payoutFeesCents || 0;
    row.connectCostCents = c.costCents || 0;
    row.cardDeposits = k.deposits || 0;
    row.cardDepositsWithoutFee = k.withoutFee || 0;
    row.cardShortfallCents = k.shortfall || 0;
    row.bankDeposits = b.deposits || 0;
    row.bankDepositsWithoutFee = b.withoutFee || 0;
    row.bankFeesAbsorbedCents = (b.absorbed || 0) + (b.verificationCost || 0);
    row.bankVerificationsEstimated = b.verifications || 0;
    row.bankVerificationCostCents = b.verificationCost || 0;
    row.bankFeesChargedCents = b.charged || 0;
    // Never more than was charged: see summarizeBankFees.
    row.bankFeesRecoveredCents = Math.min(b.recovered || 0, b.charged || 0);
    row.netCents =
      row.feeCollectedCents -
      row.connectCostCents -
      row.cardShortfallCents -
      row.bankFeesAbsorbedCents +
      row.bankFeesRecoveredCents;

    byMonth[month] = row;
    for (const key of Object.keys(total)) total[key] += row[key];
  }

  // A vendor who is paid in two months pays the account fee in both -- so
  // summing connectVendors across months is vendor-MONTHS, which is the unit
  // the fee is charged in. Labelled as such rather than as distinct vendors.
  return { byMonth, total, rates };
}

/**
 * Per landlord: fees paid and how their wallet was funded -- so the money can
 * be checked before a sweep (see the header).
 */
function summarizeLandlordFees({ feeEntries = [], deposits = [], ledgers = [] } = {}) {
  const rows = new Map();
  const row = (landlordId) => {
    const key = idOf(landlordId);
    if (!rows.has(key)) {
      rows.set(key, { landlordId: key, feeCollectedCents: 0, feeOwedCents: 0, stripeDepositsCents: 0, externalDepositsCents: 0 });
    }
    return rows.get(key);
  };

  for (const entry of feeEntries) {
    if (entry.type === "fee" && !entry.shortfall) row(entry.landlordId).feeCollectedCents += sumLines(entry, ":available", "credit");
    else if (entry.type === "fee_settlement") row(entry.landlordId).feeCollectedCents += entry.amountCents || 0;
  }
  for (const deposit of deposits) {
    if (deposit.type !== "deposit") continue;
    if (deposit.fundingSource === "stripe") row(deposit.landlordId).stripeDepositsCents += deposit.amountCents || 0;
    else if (deposit.fundingSource === "external") row(deposit.landlordId).externalDepositsCents += deposit.amountCents || 0;
  }
  for (const ledger of ledgers) {
    const r = row(ledger.landlordId);
    r.feeOwedCents = ledger.feesOwed || 0;
  }

  return [...rows.values()]
    .filter((r) => r.feeCollectedCents > 0 || r.feeOwedCents > 0)
    .map((r) => ({ ...r, checkBeforeSweep: r.feeCollectedCents > 0 && r.externalDepositsCents > 0 }))
    .sort((a, b) => b.feeCollectedCents - a.feeCollectedCents);
}

const createdIn = (range) =>
  range && (range.from || range.to)
    ? { createdAt: { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) } }
    : {};

/** Read everything and summarize. `range` ({from,to}) bounds when entries were written. */
async function buildRevenueReport({ range = null, rates = connectRates() } = {}) {
  const created = createdIn(range);

  const [feeEntries, payouts, deposits, completions, ledgers, allFeeEntries, allDeposits] = await Promise.all([
    LedgerEntry.find({ type: { $in: ["fee", "fee_settlement"] }, ...created })
      .select("landlordId type amountCents shortfall lines createdAt")
      .lean(),
    LedgerEntry.find({ type: "payout", provider: "stripe_connect", providerStatus: "paid", ...created })
      .select("type provider providerStatus identityId amountCents createdAt")
      .lean(),
    LedgerEntry.find({ type: "deposit", fundingSource: "stripe", ...created })
      .select("type fundingSource landlordId amountCents card bank memo createdAt")
      .lean(),
    JobCompletion.find({ "ledger.serviceFee": { $ne: null } }).select("ledger.serviceFee").lean(),
    LandlordLedger.find({ feesOwed: { $gt: 0 } }).select("landlordId feesOwed").lean(),
    // The per-landlord sweep check is about funding over the whole life of the
    // wallet, whatever window the monthly figures cover.
    LedgerEntry.find({ type: { $in: ["fee", "fee_settlement"] } }).select("landlordId type amountCents shortfall lines").lean(),
    LedgerEntry.find({ type: "deposit" }).select("type fundingSource landlordId amountCents").lean(),
  ]);

  const [bankFeeEntries, bankTopUps] = await Promise.all([
    LedgerEntry.find({ type: { $in: ["bank_fee", "bank_settlement"] }, ...created })
      .select("type amountCents shortfall lines createdAt")
      .lean(),
    // Each landlord's first top-up that reached the bank: the new account
    // Stripe verified (and charged for), as far as Artrelo can tell.
    WalletTopUp.find({ status: { $in: ["processing", "succeeded", "failed", "disputed"] }, processingAt: { $ne: null } })
      .select("landlordId processingAt")
      .lean(),
  ]);
  const firstByLandlord = new Map();
  for (const row of bankTopUps) {
    const key = idOf(row.landlordId);
    const at = new Date(row.processingAt);
    if (!firstByLandlord.has(key) || at < firstByLandlord.get(key)) firstByLandlord.set(key, at);
  }

  const windowed = range && (range.from || range.to);
  const inWindow = (date) =>
    !windowed || ((!range.from || new Date(date) >= range.from) && (!range.to || new Date(date) <= range.to));

  const summary = summarizeRevenue({
    feeEntries,
    completions: completions.filter((c) => inWindow(c.ledger.serviceFee.decidedAt)),
    payouts,
    deposits,
    bankFeeEntries,
    firstBankTopUps: [...firstByLandlord.values()].filter(inWindow),
    verificationFeeCents: bankDebitSettings().verificationFeeCents,
    rates,
  });

  // Principal reversals aren't an expense or fee revenue. Only Stripe's actual
  // dispute fees affect contribution, using the balance transaction's date.
  const disputes = await FundingDispute.find({}).select("transactions").lean();
  const costByMonth = summarizeDisputeCosts(disputes, range);
  summary.total.cardDisputeCostsCents = 0;
  for (const [month, cost] of Object.entries(costByMonth)) {
    if (!summary.byMonth[month]) summary.byMonth[month] = emptyMonth();
    summary.byMonth[month].cardDisputeCostsCents = cost;
    summary.byMonth[month].netCents -= cost;
    summary.total.cardDisputeCostsCents += cost;
    summary.total.netCents -= cost;
  }

  const billing = await require("../billing/billingRevenue.service").loadBillingRevenue(range);
  summary.total.invoiceProcessingCostsCents = 0;
  summary.total.invoiceDisputeCostsCents = 0;
  summary.total.invoicesWithoutProcessingCost = 0;
  for (const [month, invoice] of Object.entries(billing.byMonth)) {
    const row = summary.byMonth[month] ||= emptyMonth();
    const additions = { feeBilledCents: invoice.billed, feeOwedAtCloseCents: invoice.billed,
      feeSettledLaterCents: invoice.collected, feeCollectedCents: invoice.collected,
      feeWaivedCents: invoice.waived, feeJobs: invoice.jobs,
      invoiceProcessingCostsCents: invoice.processing, invoiceDisputeCostsCents: invoice.disputes,
      invoicesWithoutProcessingCost: invoice.unknownCosts,
      netCents: invoice.collected - invoice.processing - invoice.disputes };
    for (const [key, value] of Object.entries(additions)) {
      row[key] = (row[key] || 0) + value;
      summary.total[key] = (summary.total[key] || 0) + value;
    }
  }
  const perLandlord = summarizeLandlordFees({ feeEntries: allFeeEntries, deposits: allDeposits, ledgers });
  for (const owner of billing.perLandlord) {
    let row = perLandlord.find((r) => r.landlordId === owner.landlordId);
    if (!row) { row = { landlordId: owner.landlordId, feeCollectedCents: 0, feeOwedCents: 0, checkBeforeSweep: false, externalDepositsCents: 0, stripeDepositsCents: 0 }; perLandlord.push(row); }
    row.feeCollectedCents += owner.invoiceCollectedCents; row.feeOwedCents += owner.invoiceOwedCents;
    row.invoiceCollectedCents = owner.invoiceCollectedCents;
  }

  return {
    ...summary,
    unpaidFeesNowCents: ledgers.reduce((total, ledger) => total + (ledger.feesOwed || 0), 0) + billing.unpaidNowCents,
    perLandlord,
  };
}

function summarizeDisputeCosts(disputes = [], range = null) {
  const months = {}, seen = new Set();
  for (const dispute of disputes) for (const tx of dispute.transactions || []) {
    if (!tx.id || seen.has(tx.id) || !Number.isFinite(new Date(tx.createdAt).getTime())) continue;
    seen.add(tx.id);
    const at = new Date(tx.createdAt);
    if ((range?.from && at < range.from) || (range?.to && at > range.to)) continue;
    const month = monthKey(at);
    months[month] = (months[month] || 0) + (tx.feeCents || 0);
  }
  return months;
}

module.exports = {
  summarizeDisputeCosts,
  DEFAULT_CONNECT_RATES,
  connectRates,
  summarizeFeeEntries,
  summarizeFeeRecords,
  estimateConnectCost,
  summarizeCardShortfall,
  summarizeBankFees,
  summarizeRevenue,
  summarizeLandlordFees,
  buildRevenueReport,
};
