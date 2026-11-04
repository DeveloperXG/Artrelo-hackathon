// reconcileLedger check 4: the fees the journal took agree with what each job's
// JobCompletion says was charged.
//
// The decision lives in two places on purpose -- the ledger entry, and the
// completion's record (the only trace of a fee waived in the beta) -- so a
// disagreement in either direction is a problem worth surfacing.

const assert = require("assert");
const JobCompletion = require("../../../models/JobCompletion");

let records = [];
JobCompletion.find = () => {
  const chain = { select: () => chain, lean: async () => records };
  return chain;
};

const { checkServiceFees, feesTakenByCompletion } = require("../../../scripts/reconcileLedger");

const fee = (completionId, amountCents, extra = {}) => ({ type: "fee", completionId, amountCents, ...extra });
const rec = (id, chargedCents, extra = {}) => ({ _id: id, ledger: { serviceFee: { listCents: 500, chargedCents, ...extra } } });

async function main() {
  /* -------- 1) What counts as taken ------------------------------------ */
  const taken = feesTakenByCompletion([
    fee("c1", 500),
    fee("c2", 500, { shortfall: true }), // lost its race, reversed: nothing taken
    { type: "refund", completionId: "c2", amountCents: 500 },
    fee(null, 500), // manual close with no completion: nothing to compare against
    { type: "payout", completionId: "c1", amountCents: 31200 },
  ]);
  assert.deepStrictEqual([...taken], [["c1", 500]]);

  /* -------- 2) Agreement ----------------------------------------------- */
  records = [rec("c1", 500), rec("c3", 0, { waivedReason: "beta" })];
  let problems = await checkServiceFees({ landlordId: "L", entries: [fee("c1", 500)] });
  assert.deepStrictEqual(problems, [], "a charged fee and a waived one both agree");

  /* -------- 3) Each way they can disagree ------------------------------- */
  records = [rec("c1", 300)];
  problems = await checkServiceFees({ landlordId: "L", entries: [fee("c1", 500)] });
  assert.strictEqual(problems.length, 1);
  assert.ok(/records a 300-cent fee but the journal billed 500/.test(problems[0]), problems[0]);

  records = [];
  problems = await checkServiceFees({ landlordId: "L", entries: [fee("c1", 500)] });
  assert.ok(/no recorded fee decision/.test(problems[0]), "money taken with no decision on record");

  records = [rec("c1", 500)];
  problems = await checkServiceFees({ landlordId: "L", entries: [] });
  assert.ok(/never billed/.test(problems[0]), "a decision that says charged, with nothing billed");

  // A lost race: the stranded entry (shortfall) and its reversal don't count;
  // the re-bill as owed does, and matches the record.
  records = [rec("c2", 500, { owedCents: 500 })];
  problems = await checkServiceFees({
    landlordId: "L",
    entries: [
      fee("c2", 500, { shortfall: true }),
      { type: "refund", completionId: "c2", amountCents: 500 },
      fee("c2", 500, { idempotencyKey: "fee:c2:owed" }),
    ],
  });
  assert.deepStrictEqual(problems, []);

  console.log("reconcile service-fee check tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
