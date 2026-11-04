// While the relay is deliberately switched off, vendors and tenants must not be
// promised a "yet". With it on, an unavailable channel is a genuine gap and
// keeps the original wording.

const assert = require("assert");
const env = require("../../../config/env");
const {
  buildStubRelayContact,
  RELAY_UNAVAILABLE_LABEL,
} = require("../../../services/comms/relay.service");

function main() {
  env.relay_sms_enabled = false;
  const off = buildStubRelayContact({ managerPhone: "+15550001111" });
  assert.strictEqual(off.available, false);
  assert.strictEqual(off.phone, null, "never a number when the relay is off");
  assert.ok(!/yet/i.test(off.label), "no promise of a future feature while it is deferred");
  assert.strictEqual(off.fallback.phone, "+15550001111");

  env.relay_sms_enabled = true;
  assert.strictEqual(buildStubRelayContact().label, RELAY_UNAVAILABLE_LABEL);

  console.log("relay labels tests passed");
}

main();
