// The single definition of "this cost needs a manager's sign-off".
//
// Two callers now ask it: submitCompletion (so the vendor hears immediately)
// and closeJobCompletion (as the backstop that actually holds the money). The
// whole reason it is one exported function is that two hand-rolled comparisons
// would drift, and they would drift toward "submit said fine, close said no" —
// the exact confusion this was meant to remove. So the boundary gets pinned.

const assert = require("assert");
const {
  isOverCeiling,
  overageAllowance,
} = require("../../../services/completion/jobCompletion.service");

/* ---- The allowance: max($10, 2%) ---- */

assert.strictEqual(overageAllowance(100), 10, "small jobs get the flat floor");
assert.strictEqual(overageAllowance(320), 10, "2% of 320 is 6.40, so the floor still wins");
assert.strictEqual(overageAllowance(500), 10, "2% of 500 is exactly the floor");
assert.strictEqual(overageAllowance(2000), 40, "large jobs go proportional");

/* ---- The boundary, exactly. Strictly greater than, not >=. ---- */

// $320 ceiling, $10 allowance -> trips above $330.
assert.strictEqual(isOverCeiling({ actualCost: 320, ceiling: 320 }), false, "at the ceiling");
assert.strictEqual(isOverCeiling({ actualCost: 330, ceiling: 320 }), false, "exactly at tolerance");
assert.strictEqual(isOverCeiling({ actualCost: 330.01, ceiling: 320 }), true, "a cent past it");

// $2000 ceiling, 2% governs -> trips above $2040.
assert.strictEqual(isOverCeiling({ actualCost: 2040, ceiling: 2000 }), false);
assert.strictEqual(isOverCeiling({ actualCost: 2040.01, ceiling: 2000 }), true);

// A negotiated counter-offer ceiling behaves identically.
assert.strictEqual(isOverCeiling({ actualCost: 260, ceiling: 250 }), false);
assert.strictEqual(isOverCeiling({ actualCost: 260.01, ceiling: 250 }), true);

/* ---- Under-billing is never an overage ---- */

assert.strictEqual(isOverCeiling({ actualCost: 180, ceiling: 320 }), false);
assert.strictEqual(isOverCeiling({ actualCost: 0, ceiling: 320 }), false);

/* ---- No ceiling means nothing to measure against ---- */

for (const ceiling of [null, undefined, 0, ""]) {
  assert.strictEqual(
    isOverCeiling({ actualCost: 999999, ceiling }),
    false,
    `a ${JSON.stringify(ceiling)} ceiling must not trip — there is nothing to exceed`
  );
}

/* ---- Garbage in must not silently trip a manager approval ---- */

assert.strictEqual(isOverCeiling({ actualCost: null, ceiling: 320 }), false);
assert.strictEqual(isOverCeiling({ actualCost: undefined, ceiling: 320 }), false);
assert.strictEqual(isOverCeiling({}), false);

/* ---- Pure: no mutation of the argument ---- */

const args = { actualCost: 400, ceiling: 320 };
const frozen = { ...args };
isOverCeiling(args);
assert.deepStrictEqual(args, frozen);

console.log("isOverCeiling tests passed");
