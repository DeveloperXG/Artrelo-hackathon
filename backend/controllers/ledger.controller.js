// The landlord's wallet.
//
// Mounted under /landlords, which already applies userAuth + the landlord role
// check, and every handler scopes by req.user.id. Deliberately NOT under
// /api/v1/payments — that controller and services/payment/ mean tenant RENT,
// which is a different product surface with a different counterparty.

const LedgerEntry = require("../models/LedgerEntry");
const JobCompletion = require("../models/JobCompletion");
const Landlord = require("../models/Landlord");
const {
  account,
  markPayoutPaid,
  settlePayout,
  getBalance,
  unfundedDeferredCents,
} = require("../services/ledger/ledger.service");
const { toCents, fromCents } = require("../services/ledger/money");
const { getLowFundsStatus } = require("../services/ledger/lowBalance.service");
const { MIN_CARD_DEPOSIT_CENTS } = require("../services/ledger/cardFees");
const { cardPilotFor } = require("../services/ledger/cardPilot");
const { activeProvider, createDepositIntent, isConfigured } = require("../services/ledger/payoutProvider.service");
const WalletTopUp = require("../models/WalletTopUp");
// Through the module object so a test can stand in for it.
const bankTopUps = require("../services/ledger/bankTopUp.service");
const { logAgentAction } = require("../services/audit/agentAction.service");
const { buildBetaView } = require("../services/beta/beta.service");
const { resolveRate, isZeroRate, buildServiceFeeLine } = require("../services/ledger/serviceFee");
const { describeFee } = require("../config/beta");
const { landlordPaymentMode } = require("../services/ledger/paymentMode");
const directPayments = require("../services/ledger/directPayment.service");

/**
 * Turn one journal row into one line of a STATEMENT.
 *
 * The journal is double-entry and says things like "hold_release". That is the
 * right shape for reconciliation and the wrong shape for a landlord, who is
 * asking "what happened to my money". So each row gets a plain-language title,
 * a signed direction, and — where it exists — the job and vendor it belongs to.
 *
 * Dollars out, cents in: the UI never sees a cent integer.
 */
function presentEntry(entry) {
  const job = entry.requestId && typeof entry.requestId === "object" ? entry.requestId : null;
  const vendor = entry.identityId && typeof entry.identityId === "object" ? entry.identityId : null;
  const jobTitle = job?.ai?.shortTitle || job?.issueTitle || null;
  const vendorName = vendor?.displayName || null;

  // `in` money arrives, `out` money leaves, `neutral` moves between the
  // landlord's own buckets and should never read as a gain or a loss.
  const DIRECTIONS = {
    deposit: "in",
    payout: "out",
    fee: "out",
    // The fee row already showed as money out; this is the top-up settling it,
    // the same relationship arrears_settlement has to a payout.
    fee_settlement: "neutral",
    refund: "in",
    hold: "neutral",
    hold_release: "neutral",
    hold_void: "neutral",
    payout_reversal: "in",
    // The deposit already showed as money in, and the payout it funds already
    // shows as money out. This row is the link between them, not a third move.
    arrears_settlement: "neutral",
    adjustment: "neutral",
    // A disputed bank top-up taken back, and the bank's fee for it (or for a
    // debit that failed): both are money leaving the wallet.
    deposit_reversal: "out",
    bank_fee: "out",
    // The reversal already showed as money out; this is a top-up paying it back.
    bank_settlement: "neutral",
  };

  const titles = {
    deposit:
      entry.fundingSource !== "stripe"
        ? "Recorded an external transfer"
        : entry.memo === "Bank top-up"
          ? "Added funds from your bank"
          : "Added funds by card",
    deposit_reversal: "Bank top-up reversed",
    bank_fee: "Bank fee",
    bank_settlement: "Paid back a reversed bank top-up",
    // Every row that involves a vendor names the VENDOR in the title and lets
    // the job fall to the subtitle. A statement scans down the left edge, so
    // the counterparty is what belongs there — "Reserved for No power to
    // lights" read as though the money were reserved for a symptom.
    hold: vendorName ? `Reserved for ${vendorName}` : "Reserved for a booked job",
    hold_void: vendorName ? `Reservation returned — ${vendorName}` : "Reservation returned",
    hold_release: "Reservation released",
    // A payable posting may still be pending/manual/failed. Provider status
    // records delivery separately; the journal row must not imply it was paid.
    payout: vendorName ? `Vendor payment to ${vendorName}` : "Vendor payment",
    payout_reversal: "Payment reversed",
    arrears_settlement: vendorName
      ? `Applied to ${vendorName}'s remaining payment`
      : "Covered an under-funded booking",
    fee: "Artrelo service fee",
    fee_settlement: "Paid unpaid service fees",
    refund: "Refund",
    adjustment: "Adjustment",
  };

  return {
    id: entry._id,
    type: entry.type,
    title: titles[entry.type] || entry.type,
    direction: DIRECTIONS[entry.type] || "neutral",
    amount: fromCents(entry.amountCents),
    currency: entry.currency,
    createdAt: entry.createdAt,
    memo: entry.memo,
    jobTitle,
    vendorName,
    requestId: job?._id || entry.requestId || null,
    provider: entry.provider,
    providerStatus: entry.providerStatus,
    providerRef: entry.providerRef,
    // On an awaiting_clearance payout: when Stripe expects to have cleared the
    // money it sends from. An estimate, for the row's explanation.
    clearsOn: entry.clearsOn || null,
    shortfall: Boolean(entry.shortfall),
    fundingSource: entry.fundingSource || "none",
    scope: entry.scope,
    balanceAfter: entry.balanceAfter?.available !== null && entry.balanceAfter?.available !== undefined
      ? { available: fromCents(entry.balanceAfter.available), held: fromCents(entry.balanceAfter.held || 0) }
      : null,
  };
}

/**
 * Fold the journal into what a person would recognise as a record.
 *
 * The one real transformation: a completed job writes BOTH a hold_release (the
 * full reservation coming out of escrow) and a payout (what the vendor actually
 * charged). Those are one event to a landlord — "paid $240, and the $60 you had
 * set aside came back" — and showing them as two adjacent rows reads like the
 * money moved twice.
 *
 * So the release is absorbed into its payout as `returnedToBalance`. Nothing is
 * deleted; the journal is untouched and reconcileLedger still sees both.
 *
 * "Returned" is what the release actually put back in `available`, not the
 * hold's face value: an under-funded hold returns only the part that was ever
 * deposited. And a short job can have two payouts (sent now, and the deferred
 * remainder), so the job's total cost is what gets subtracted, once.
 *
 * `related` is every hold_release and payout of the completions on this page,
 * newest first. The statement is paged, and a job's release and its sibling
 * payouts can fall on other pages than the row being shown — folding from the
 * page alone would lose the release or count half the cost. It defaults to the
 * entries themselves, which is the whole story when they are the whole journal.
 */
function buildStatement(entries, related = entries, serviceFees = new Map()) {
  const releasesByCompletion = new Map();
  const payoutTotalByCompletion = new Map();
  // Only the newest payout of a job carries the annotation, so it is said once
  // — and the same row carries it whichever page is being shown.
  const annotatedPayoutByCompletion = new Map();
  for (const entry of related) {
    if (!entry.completionId) continue;
    const key = String(entry.completionId);
    if (entry.type === "hold_release") releasesByCompletion.set(key, entry);
    if (entry.type === "payout") {
      payoutTotalByCompletion.set(key, (payoutTotalByCompletion.get(key) || 0) + entry.amountCents);
      if (!annotatedPayoutByCompletion.has(key)) annotatedPayoutByCompletion.set(key, String(entry._id));
    }
  }

  const rows = [];

  for (const entry of entries) {
    if (entry.type === "hold_release" && entry.completionId) continue;
    const row = presentEntry(entry);

    const key = entry.completionId ? String(entry.completionId) : null;
    if (entry.type === "payout" && key && annotatedPayoutByCompletion.get(key) === String(entry._id)) {
      const release = releasesByCompletion.get(key);
      if (release) {
        const landlordAvailable = account.available(String(entry.landlordId));
        const returned = (release.lines || [])
          .filter((line) => line.account === landlordAvailable && line.direction === "debit")
          .reduce((total, line) => total + line.amountCents, 0);
        const unspent = returned - (payoutTotalByCompletion.get(key) || 0);
        if (unspent > 0) row.returnedToBalance = fromCents(unspent);
      }
      // The service fee is said on the payout it belongs to. A charged fee also
      // has its OWN row -- it is money leaving the wallet and the balance column
      // has to add up -- but a fee waived during the beta has no ledger entry at
      // all, so this annotation is the only place the landlord ever sees it.
      const fee = serviceFees.get(key);
      if (fee && fee.listCents > 0) {
        row.serviceFee = {
          amount: fromCents(fee.listCents),
          charged: fromCents(fee.chargedCents || 0),
          waived: fee.waivedReason || null,
          owed: fromCents(fee.owedCents || 0),
        };
      }
    }
    rows.push(row);
  }

  return rows;
}

// The statement's filter chips. "Paid out" includes the arrears settlement that
// completes a short-paid job; "refunded" is anything that came back to the
// landlord. Fees and adjustments appear under "all" only.
const LEDGER_KINDS = {
  all: null,
  added: ["deposit"],
  held: ["hold"],
  paid: ["payout", "arrears_settlement"],
  refunded: ["refund", "payout_reversal", "hold_void"],
};

// A payout the landlord is still waiting on, in any of the ways it can wait.
// A fee that lost its race (ledger.service.chargeServiceFee) is written and then
// reversed in the same instant, without the balance ever moving. Both rows stay
// in the journal for reconcile; neither means anything to a landlord, and a
// "Refund" for a fee they were never charged would read as an error.
const HIDDEN_FROM_STATEMENT = [
  { type: "fee", shortfall: true },
  { type: "refund", idempotencyKey: { $regex: /^fee:.*:void$/ } },
  // The same lost race for a bank reversal or bank fee (ledger.service.takeOrOwe).
  { type: { $in: ["deposit_reversal", "bank_fee"] }, shortfall: true },
  { type: "refund", idempotencyKey: { $regex: /^(deposit_reversal|bank_fee):.*:void$/ } },
];

const UNSETTLED_PAYOUT_STATUSES = [
  "pending",
  "pending_manual",
  "pending_onboarding",
  "awaiting_funds",
  "awaiting_clearance",
];

/**
 * Both fee-related payload fields from ONE landlord read:
 *
 *   serviceFeeLine  the line under the Wallet cards, for every landlord --
 *                   waived / founding / list (buildServiceFeeLine).
 *   foundingFee     founding details; `declined` drives the "review it" link.
 *                   Null for a landlord who neither accepted nor declined.
 *
 * Best-effort at the call site, like lowFunds: a nicety never takes the
 * statement down.
 */
async function loadFeeInfo(landlordId) {
  const landlord = await Landlord.findById(landlordId).select("beta foundingAgreement").lean();
  if (!landlord) return { foundingFee: null, serviceFeeLine: null };
  return { foundingFee: foundingFeeFor(landlord), serviceFeeLine: buildServiceFeeLine(landlord) };
}

function foundingFeeFor(landlord) {
  const view = buildBetaView(landlord, {});
  if (!view.founding && view.offer !== "declined") return null;

  let rate = null;
  let locked = false;
  if (view.founding) {
    const resolved = resolveRate(landlord);
    if (resolved.source !== "list" && !isZeroRate(resolved.rate)) {
      rate = {
        flat: fromCents(resolved.rate.flatCents),
        percent: resolved.rate.percent,
        description: describeFee(resolved.rate),
      };
      locked = resolved.source === "founding_locked";
    }
  }

  return {
    founding: view.founding,
    since: view.foundingSince,
    declined: view.offer === "declined",
    // The beta is over, so the fee is real. Before that the per-row "waived"
    // note on each job already covers it and this line stays quiet.
    betaEnded: view.inBeta && !view.active,
    rate,
    locked,
  };
}

/**
 * The bank top-up state the Wallet shows: the offer (bankStatusFor), each top-up
 * still at the bank, and the most recent failure -- only while nothing newer
 * has started since, so trying again clears it.
 */
async function loadBankTopUps(landlordId) {
  const bankDebit = await bankTopUps.bankStatusFor(landlordId);
  const rows = await WalletTopUp.find({
    landlordId,
    status: { $in: ["processing", "failed", "disputed", "succeeded", "created"] },
  })
    .select("walletCents status processingAt expectedAt failedAt failureMessage disputedAt createdAt")
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  const pendingTopUps = rows
    .filter((row) => row.status === "processing")
    .map((row) => {
      const startedAt = row.processingAt || row.createdAt;
      // The same 3–5 business days the top-up form promises, as a date range.
      const window = bankTopUps.expectedWindow(startedAt, row.expectedAt);
      return { amount: fromCents(row.walletCents), startedAt, expectedFrom: window.from, expectedAt: window.to };
    });

  // The newest top-up that got anywhere (a `created` one may be an abandoned
  // form and says nothing). A failure is shown only while it is the latest.
  const latest = rows.find((row) => row.status !== "created");
  const recent = latest && Date.now() - new Date(latest.failedAt || latest.disputedAt || 0) < 14 * 24 * 60 * 60 * 1000;
  const bankTopUpFailure =
    latest && recent && (latest.status === "failed" || latest.status === "disputed")
      ? {
          kind: latest.status,
          amount: fromCents(latest.walletCents),
          at: latest.failedAt || latest.disputedAt,
          message: latest.status === "failed" ? latest.failureMessage || null : null,
        }
      : null;

  return { bankDebit, pendingTopUps, bankTopUpFailure };
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function parsePaging(query = {}) {
  const limitRaw = Number.parseInt(query.limit, 10);
  const pageRaw = Number.parseInt(query.page, 10);
  const kind = Object.prototype.hasOwnProperty.call(LEDGER_KINDS, query.kind) ? query.kind : "all";
  return {
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
    kind,
  };
}

const sumCents = (rows) => rows.reduce((total, row) => total + (row.amountCents || 0), 0);

/**
 * GET /landlords/ledger?page&limit&kind
 *
 * The balance summary plus ONE page of the statement, newest first. Paged on
 * the server because the journal only grows; the old fixed "latest 100" simply
 * hid everything older.
 */
exports.getLedger = async (req, res) => {
  try {
    const landlordId = req.user.id;
    const { limit, page: requestedPage, kind } = parsePaging(req.query);
    const balance = await getBalance(landlordId);

    // Folded releases are excluded in the query, not after the fetch, so page
    // sizes and the total describe the rows actually shown. A release with no
    // completion is not folded and still appears, as it always did.
    const statementFilter = LEDGER_KINDS[kind]
      ? { landlordId, type: { $in: LEDGER_KINDS[kind] }, $nor: HIDDEN_FROM_STATEMENT }
      : { landlordId, $nor: [{ type: "hold_release", completionId: { $ne: null } }, ...HIDDEN_FROM_STATEMENT] };

    const total = await LedgerEntry.countDocuments(statementFilter);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    // A page past the end (the list shrank, or a stale link) shows the last one.
    const page = Math.min(requestedPage, totalPages);

    // Populated so a row can say "Paid Northline Plumbing — Kitchen sink
    // leaking" instead of "payout". Without these the statement is a list of
    // amounts with no story attached to them. _id breaks createdAt ties so a
    // row can never land on two pages.
    const entries = await LedgerEntry.find(statementFilter)
      .populate("requestId", "issueTitle ai.shortTitle")
      .populate("identityId", "displayName")
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // The releases and sibling payouts this page's payouts fold against,
    // wherever they fall in the journal.
    const completionIds = [
      ...new Set(entries.filter((e) => e.type === "payout" && e.completionId).map((e) => String(e.completionId))),
    ];
    const related = completionIds.length
      ? await LedgerEntry.find({
          landlordId,
          completionId: { $in: completionIds },
          type: { $in: ["hold_release", "payout"] },
        })
          .select("_id type completionId amountCents lines landlordId createdAt")
          .sort({ createdAt: -1, _id: -1 })
          .lean()
      : [];

    // The fee decision for each job on the page -- the only record of one that
    // was waived. Scoped by landlordId as well as id: completion ids come from
    // this landlord's own entries, but the read stays honest on its own.
    //
    // A nicety, like lowFunds below: it never takes the statement down. A
    // charged fee still shows as its own row without it.
    const serviceFees = new Map(
      completionIds.length
        ? await JobCompletion.find({ _id: { $in: completionIds }, landlordId, "ledger.serviceFee": { $ne: null } })
            .select("_id ledger.serviceFee")
            .lean()
            .then((rows) => rows.map((c) => [String(c._id), c.ledger.serviceFee]))
            .catch((err) => {
              console.error("[getLedger] service fee lookup failed", err.message);
              return [];
            })
        : []
    );

    // How much of this landlord's balance is backed by money Stripe can
    // actually send. External top-ups credit the ledger without funding the
    // platform balance, so a wallet can read healthy and still be unspendable —
    // surfacing the number is the only way that is ever visible. Summed over
    // the whole journal: it used to read only the newest 100 rows, so a long
    // history quietly understated it.
    const externalCents = sumCents(
      await LedgerEntry.find({ landlordId, type: "deposit", fundingSource: "external" })
        .select("amountCents")
        .lean()
    );

    // Payouts not yet delivered, for the "Pending payouts" tile.
    const unsettledCents = sumCents(
      await LedgerEntry.find({ landlordId, type: "payout", providerStatus: { $in: UNSETTLED_PAYOUT_STATUSES } })
        .select("amountCents")
        .lean()
    );

    // THIS landlord's card top-ups that have not cleared yet, at the amount
    // their wallet received. This used to be the Stripe PLATFORM balance's
    // pending figure, which is every landlord's money summed, after Stripe's
    // fee: a $1 top-up read "$0.67 is still clearing", and each landlord could
    // see the others' totals.
    const now = new Date();
    // A reversed (disputed) bank top-up will never clear: the bank took it back.
    // Without this the wallet promised "$200 available around Wed 21 Oct" for
    // money already gone (seen in the sandbox run).
    const reversedRefs = (
      await LedgerEntry.find({ landlordId, type: "deposit_reversal", shortfall: { $ne: true } })
        .select("providerRef")
        .lean()
    )
      .map((row) => row.providerRef)
      .filter(Boolean);
    const clearingRows = (
      await LedgerEntry.find({
        landlordId,
        type: "deposit",
        fundingSource: "stripe",
        ...(reversedRefs.length ? { providerRef: { $nin: reversedRefs } } : {}),
        $or: [{ "card.availableOn": { $gt: now } }, { "bank.availableOn": { $gt: now } }],
      })
        .select("amountCents createdAt memo card.availableOn bank.availableOn")
        .lean()
    )
      .map((row) => ({ ...row, availableOn: row.card?.availableOn || row.bank?.availableOn }))
      .sort((a, b) => new Date(a.availableOn) - new Date(b.availableOn));

    // Arrears has two sources and the wallet must not call them the same thing:
    // completed work a vendor is waiting on, versus booked jobs the balance
    // does not yet cover.
    const owedCents = Math.min(balance.arrears, await unfundedDeferredCents(landlordId));

    return res.json({
      success: true,
      data: {
        balance: {
          available: fromCents(balance.available),
          held: fromCents(balance.held),
          arrears: fromCents(balance.arrears),
          lifetimeDeposited: fromCents(balance.lifetimeDeposited),
          lifetimeReleased: fromCents(balance.lifetimeReleased),
          feesOwed: fromCents(balance.feesOwed || 0),
          currency: balance.currency,
        },
        owedToVendors: fromCents(owedCents),
        // Service fees the wallet did not cover when a job closed. Paid by the
        // next top-up, after any vendor waiting on funds.
        unpaidServiceFees: fromCents(balance.feesOwed || 0),
        bookingShortfall: fromCents(Math.max(0, balance.arrears - owedCents)),
        clearing: clearingRows.map((row) => ({
          amount: fromCents(row.amountCents),
          paidAt: row.createdAt,
          availableOn: row.availableOn,
          method: row.memo === "Bank top-up" ? "bank" : "card",
        })),
        // Owed after a bank top-up was reversed once spent (or a bank fee the
        // wallet could not cover). The next card or bank top-up pays it.
        bankOwed: fromCents(balance.bankOwed || 0),
        // Bank top-ups: what this landlord may do, the ones still at the bank,
        // and the latest failure. Best-effort, like lowFunds.
        ...(await loadBankTopUps(landlordId).catch((err) => {
          console.error("[getLedger] bank top-up lookup failed", err.message);
          return { bankDebit: { enabled: false }, pendingTopUps: [], bankTopUpFailure: null };
        })),
        externalDeposits: fromCents(externalCents),
        pendingPayouts: fromCents(unsettledCents),
        // The Wallet's own low-funds banner: the warning used to exist only as
        // a one-off notification after a payout. A nicety, so it never takes
        // the statement down with it -- null just means no banner.
        lowFunds: await getLowFundsStatus({ landlordId, availableCents: balance.available }).catch((err) => {
          console.error("[getLedger] low-funds status failed", err.message);
          return null;
        }),
        ...(await loadFeeInfo(landlordId).catch((err) => {
          console.error("[getLedger] fee lookup failed", err.message);
          return { foundingFee: null, serviceFeeLine: null };
        })),
        payoutProvider: activeProvider(),
        // How this landlord's vendors are paid. "direct" turns the page into
        // Payments: jobs owed and paid outside Artrelo, and no top-up form.
        // Best-effort like the fee line: null on a failed read, which the page
        // treats as the full wallet rather than hiding it.
        paymentMode: await Landlord.findById(landlordId)
          .select("paymentMode")
          .lean()
          .then(landlordPaymentMode)
          .catch((err) => {
            console.error("[getLedger] payment mode lookup failed", err.message);
            return null;
          }),
        // Listed for every landlord, not only direct ones: a landlord switched to
        // platform payouts can still have direct jobs booked before the switch.
        directPayments: await loadDirectPayments(landlordId).catch((err) => {
          console.error("[getLedger] direct payment lookup failed", err.message);
          return { due: [], paid: [], dueTotal: 0 };
        }),
        // Whether this server can take a card or bank payment at all (a Stripe
        // key is configured). Without it the dialog says so up front rather than
        // offering a card form that can only fail.
        onlinePayments: isConfigured(),
        cardPilot: cardPilotFor(landlordId),
        entries: buildStatement(entries, related, serviceFees),
        pagination: { page, limit, total, totalPages, kind },
      },
    });
  } catch (err) {
    console.error("[getLedger] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Start a top-up: creates a PaymentIntent and hands back a client_secret.
 *
 * Deliberately writes NOTHING to the ledger. The deposit entry is posted by the
 * payment_intent.succeeded webhook and nowhere else — crediting here would let
 * a landlord spend money that never actually arrived, which is precisely the
 * gap this endpoint exists to close.
 *
 * `method: "bank"` is a pre-authorized debit (bankTopUp.service): no fee on
 * top, days to settle, and risk rules for a new landlord. Anything else is the
 * card top-up, exactly as it was before bank top-ups existed.
 */
exports.createDepositIntentHandler = async (req, res) => {
  if (req.body?.method === "bank") return startBankTopUpHandler(req, res);
  try {
    const amount = Number(req.body?.amount);
    const pilot = cardPilotFor(req.user.id);
    const pilotAmount = pilot && amount === fromCents(pilot.amountCents);
    const minimum = fromCents(MIN_CARD_DEPOSIT_CENTS);
    if (!Number.isFinite(amount) || (!pilotAmount && amount < minimum) || amount > 1000000) {
      // `field` lets the dialog put this beside the amount input, not in a toast.
      return res.status(400).json({
        success: false,
        field: "amount",
        message: pilot ? `This pilot permits exactly $1. Other card top-ups start at $${minimum}.` : `Card top-ups start at $${minimum}. Enter an amount between $${minimum} and $1,000,000.`,
      });
    }

    // The browser's id for this attempt, when it sends one: a double-click
    // then reuses ONE intent instead of minting two.
    const token = typeof req.body?.clientToken === "string" && /^[A-Za-z0-9-]{8,64}$/.test(req.body.clientToken)
      ? req.body.clientToken
      : null;
    const result = await createDepositIntent({
      landlordId: req.user.id,
      amountCents: toCents(amount),
      idempotencyKey: pilotAmount ? `topup:${req.user.id}:pilot:${pilot.reference}` : token ? `topup:${req.user.id}:card:${token}` : null,
    });

    if (!result.configured) {
      return res.status(503).json({
        success: false,
        code: "payments_not_configured",
        message: "Card and bank top-ups aren't set up on this server: it isn't connected to Stripe, so nothing can be charged here. You can still record a transfer you've already sent.",
      });
    }

    await logAgentAction({
      landlordId: req.user.id,
      actor: "landlord",
      actionType: "ledger_deposit_intent",
      summary: `Started a $${amount} card top-up`,
      input: { amount },
      output: { paymentIntentId: result.paymentIntentId },
    });

    // The client_secret is scoped to this intent and is safe for the browser
    // that owns it — it can confirm this one payment and nothing else.
    return res.status(201).json({
      success: true,
      data: {
        clientSecret: result.clientSecret,
        paymentIntentId: result.paymentIntentId,
        // Shown before the landlord pays: what reaches the wallet, the card
        // processing fee on top, and the total the card is charged.
        walletAmount: fromCents(result.walletCents),
        processingFee: fromCents(result.feeCents),
        chargeAmount: fromCents(result.chargeCents),
      },
    });
  } catch (err) {
    console.error("[createDepositIntent] error", err?.message || err);
    return res.status(502).json({ success: false, message: "Could not start the top-up." });
  }
};

const BANK_REFUSAL_STATUS = {
  bank_disabled: 409,
  bank_blocked: 409,
  one_in_flight: 409,
  no_saved_bank: 409,
  not_configured: 503,
  payments_not_configured: 503,
  not_found: 404,
};

async function startBankTopUpHandler(req, res) {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      return res.status(400).json({ success: false, field: "amount", message: "Enter an amount up to $1,000,000." });
    }
    const result = await bankTopUps.startBankTopUp({
      landlordId: req.user.id,
      amountCents: toCents(amount),
      clientToken: req.body?.clientToken,
      useSaved: req.body?.useSaved === true,
      transactionType: req.body?.transactionType,
    });
    if (result.refused) {
      const { code, field, message } = result.refused;
      return res
        .status(BANK_REFUSAL_STATUS[code] || 400)
        .json({ success: false, code, ...(field ? { field } : {}), message });
    }

    await logAgentAction({
      landlordId: req.user.id,
      actor: "landlord",
      actionType: "ledger_deposit_intent",
      summary: `Started a $${amount} bank top-up${req.body?.useSaved === true ? " from a saved account" : ""}`,
      input: { amount, method: "bank", useSaved: req.body?.useSaved === true },
      output: { paymentIntentId: result.paymentIntentId, status: result.status },
    });

    return res.status(201).json({
      success: true,
      data: {
        method: "bank",
        // Null-safe for a saved account: it was confirmed here and the browser
        // has nothing to mount.
        clientSecret: result.clientSecret,
        paymentIntentId: result.paymentIntentId,
        status: result.status,
        walletAmount: fromCents(result.walletCents),
        processingFee: 0,
        chargeAmount: fromCents(result.walletCents),
      },
    });
  } catch (err) {
    // A replayed idempotency key with different parameters lands here too.
    console.error("[startBankTopUp] error", err?.message || err);
    return res.status(502).json({ success: false, message: "Could not start the bank top-up." });
  }
}

/**
 * Recording an EXTERNAL top-up -- money the landlord said they sent by wire or
 * e-transfer -- is retired. It credited the ledger with money Stripe never
 * received, and a vendor payout drew on that credit: releaseHold pays from
 * `available`, which included it, and Stripe's balance is shared by every
 * landlord, so the transfer could succeed on other landlords' money.
 *
 * A landlord who pays vendors themselves is on direct pay now, and marks the
 * job paid (markDirectPaymentPaid) without any wallet balance. The route stays
 * so an old client gets a reason rather than a 404. Existing external deposits
 * stay in the journal and on the statement.
 */
exports.createDeposit = (req, res) =>
  res.status(410).json({
    success: false,
    code: "external_deposits_retired",
    message: "Recording a transfer is no longer available. Top up by card or bank, or mark direct payments paid on the Payments page.",
  });

/** Dollars out, like the rest of the payload. */
function toDirectPaymentView(row) {
  const { amountCents, ...rest } = row;
  return { ...rest, amount: fromCents(amountCents) };
}

async function loadDirectPayments(landlordId) {
  const { due, paid, dueTotalCents } = await directPayments.listDirectPayments(landlordId);
  return { due: due.map(toDirectPaymentView), paid: paid.map(toDirectPaymentView), dueTotal: fromCents(dueTotalCents) };
}

const DIRECT_PAYMENT_REFUSALS = {
  not_found: [404, "Job not found."],
  not_direct: [409, "Artrelo pays this vendor from your wallet, so there is nothing to mark."],
  not_due: [409, "This job isn't finished yet, so nothing is owed."],
  raced: [409, "This payment changed while you were saving. Refresh and try again."],
};

/**
 * The landlord paid a vendor directly. Their word is the record: the money
 * never passed through Artrelo, so there is nothing else to check against.
 */
exports.markDirectPaymentPaid = async (req, res) => {
  try {
    const reference = req.body?.reference == null ? null : String(req.body.reference);
    const result = await directPayments.markDirectPaymentPaid({
      appointmentId: req.params.id,
      landlordId: req.user.id,
      reference,
    });
    if (result.refused) {
      const [status, message] = DIRECT_PAYMENT_REFUSALS[result.refused] || [409, "That payment can't be marked paid."];
      return res.status(status).json({ success: false, code: result.refused, message });
    }
    const payment = result.appointment.directPayment;
    return res.json({
      success: true,
      data: {
        appointmentId: String(result.appointment._id),
        alreadyPaid: Boolean(result.alreadyPaid),
        status: payment.status,
        amount: fromCents(payment.amountCents),
        paidAt: payment.paidAt,
        reference: payment.reference || null,
      },
    });
  } catch (err) {
    // A malformed id is a client error, not a server one.
    if (err?.name === "CastError") return res.status(404).json({ success: false, message: "Job not found." });
    console.error("[markDirectPaymentPaid] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Confirm an off-platform payment.
 *
 * The day-one rail, and the same seam the Stripe webhook writes through. It is
 * the ONLY way a pending_manual entry becomes paid — the offline provider
 * deliberately never reports `delivered`, because a vendor marked paid who was
 * never paid is the one failure this whole design exists to avoid.
 */
exports.markPaid = async (req, res) => {
  try {
    const entry = await LedgerEntry.findOne({ _id: req.params.id, landlordId: req.user.id });
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });

    const { entry: updated, refused } = await markPayoutPaid({
      entryId: entry._id,
      reference: String(req.body?.reference || "").trim().slice(0, 120) || null,
      actor: "landlord",
    });

    if (refused) {
      // Say WHY. "Paid" is a claim about the world, and the reasons it can be
      // refused are all things the landlord can act on.
      const messages = {
        already_paid: "That payout is already settled.",
        no_payout_destination:
          "This vendor hasn't added their bank details yet, so there's nowhere for the money to have gone. It pays out automatically once they do.",
        settles_automatically:
          "This payout is being sent through Stripe and will settle on its own. Marking it by hand would hide the real outcome.",
        not_manually_payable: "That payout can't be marked paid by hand.",
        raced: "That payout changed while you were deciding. Refresh and try again.",
        not_found: "Payout not found.",
      };
      return res.status(refused === "not_found" ? 404 : 409).json({
        success: false,
        code: refused,
        message: messages[refused] || "That payout can't be marked paid.",
      });
    }

    await logAgentAction({
      requestId: updated.requestId,
      landlordId: req.user.id,
      actor: "landlord",
      actionType: "payout_marked_paid",
      summary: `Marked a $${fromCents(updated.amountCents)} vendor payout as paid`,
      input: { entryId: String(updated._id) },
      output: { providerRef: updated.providerRef },
    });

    return res.json({ success: true, data: presentEntry(updated) });
  } catch (err) {
    console.error("[markPaid] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/** Retry a payout that failed or was parked awaiting vendor onboarding. */
exports.retryPayout = async (req, res) => {
  try {
    const entry = await LedgerEntry.findOne({
      _id: req.params.id,
      landlordId: req.user.id,
      type: "payout",
    });
    if (!entry) return res.status(404).json({ success: false, message: "Payout not found" });

    const result = await settlePayout({ entryId: entry._id });
    const fresh = await LedgerEntry.findById(entry._id).lean();
    return res.json({
      success: true,
      data: { alreadyPaid: Boolean(result?.alreadyPaid), entry: presentEntry(fresh) },
    });
  } catch (err) {
    console.error("[retryPayout] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.presentEntry = presentEntry;
exports.buildStatement = buildStatement;
