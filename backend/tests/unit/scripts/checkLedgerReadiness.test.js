const assert = require("assert");
const { checkLedgerReadiness } = require("../../../scripts/check_ledger_readiness");
async function run() {
  let captures = [];
  const capture = (...value) => captures.push(value);
  let result = await checkLedgerReadiness({ check: async () => ({ ok: true, problems: [] }), capture });
  assert.strictEqual(result.ok, true); assert.strictEqual(captures.length, 0);
  result = await checkLedgerReadiness({ check: async () => ({ ok: false, problems: ["synthetic mismatch"] }), capture });
  assert.strictEqual(result.ok, false); assert.strictEqual(captures.length, 1);
  assert.strictEqual(captures[0][1].tags.check, "ledger_reconciliation");
  assert.ok(!JSON.stringify(captures).includes("synthetic mismatch"), "monitor event has no financial details");
  console.log("scheduled ledger monitor result/alert tests passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
