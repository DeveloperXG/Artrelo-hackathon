const assert = require("assert");
const {
  normalizeCity,
  cityMatches,
} = require("../../../services/vendor/location.helpers");

assert.strictEqual(normalizeCity("Calgary, AB"), "calgary");
assert.strictEqual(cityMatches("Calgary", "calgary", []), true);
assert.strictEqual(cityMatches("Calgary", "", ["Calgary, AB"]), true);
assert.strictEqual(cityMatches("Calgary", "", []), false);
assert.strictEqual(cityMatches("", "Calgary", ["Calgary"]), false);

console.log("vendor location helper tests passed");
