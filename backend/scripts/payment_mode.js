// Operator control over how a landlord's vendors are paid.
//
//   node scripts/payment_mode.js show --email dana@example.com
//   node scripts/payment_mode.js set --email dana@example.com --mode platform
//
// Against production, from backend/:
//
//   railway run node scripts/payment_mode.js show --email dana@example.com
//
// Every landlord starts on DIRECT pay: they pay vendors themselves and mark the
// job paid. Switching one to PLATFORM payouts (Artrelo pays the vendor from the
// wallet via Stripe Connect) happens when they ask for it -- a decision made
// after talking to them, so a script rather than a screen.
//
// A switch only affects jobs booked AFTER it: each appointment keeps the rail
// it was booked on (Appointment.paymentMode), so nothing in flight is split.
// Switching back to direct is allowed but warned about when the landlord still
// has wallet money or live holds -- those keep settling on the platform rail,
// and the balance stays theirs to use or have refunded.

const mongoose = require("mongoose");

const env = require("../config/env");
const Landlord = require("../models/Landlord");
const LandlordLedger = require("../models/LandlordLedger");
const Appointment = require("../models/Appointment");
const { normalizeEmail } = require("../services/auth/account.service");
const { fromCents } = require("../services/ledger/money");
const { DIRECT, PLATFORM, landlordPaymentMode } = require("../services/ledger/paymentMode");
const { parseArgs } = require("./bank_debit_admin");

const MODES = [DIRECT, PLATFORM];
const dollars = (cents) => `$${fromCents(cents || 0).toFixed(2)}`;

/** Pure: what `show` prints, and what `set` warns about. Exported for tests. */
function describe({ landlord, ledger, liveHoldCount = 0, directDue = { count: 0, cents: 0 } }) {
  const warnings = [];
  const balanceCents = ledger?.available || 0;
  const heldCents = ledger?.held || 0;
  if (balanceCents > 0) warnings.push(`has ${dollars(balanceCents)} in their wallet`);
  if (heldCents > 0 || liveHoldCount > 0) warnings.push(`has ${liveHoldCount} live platform job(s) holding ${dollars(heldCents)}`);
  return {
    email: landlord.email,
    mode: landlordPaymentMode(landlord),
    wallet: dollars(balanceCents),
    held: dollars(heldCents),
    directDue: `${directDue.count} job(s), ${dollars(directDue.cents)}`,
    warnings,
  };
}

async function load(landlord) {
  const [ledger, liveHoldCount, due] = await Promise.all([
    LandlordLedger.findOne({ landlordId: landlord._id }).select("available held").lean(),
    Appointment.countDocuments({
      landlordId: landlord._id,
      paymentMode: { $ne: DIRECT },
      status: { $nin: ["completed", "cancelled", "failed"] },
    }),
    Appointment.find({ landlordId: landlord._id, "directPayment.status": "due" }).select("directPayment.amountCents").lean(),
  ]);
  return describe({
    landlord,
    ledger,
    liveHoldCount,
    directDue: { count: due.length, cents: due.reduce((sum, a) => sum + (a.directPayment?.amountCents || 0), 0) },
  });
}

function print(view) {
  console.log(`\n${view.email}`);
  console.log(`  mode:        ${view.mode}`);
  console.log(`  wallet:      ${view.wallet} available, ${view.held} held`);
  console.log(`  direct due:  ${view.directDue}`);
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!["show", "set"].includes(command)) {
    throw new Error("Unknown or missing command (show --email <email> | set --email <email> --mode direct|platform)");
  }
  const email = normalizeEmail(args.email || "");
  if (!email) throw new Error("--email is required");
  if (command === "set" && !MODES.includes(args.mode)) throw new Error("--mode must be direct or platform");

  await mongoose.connect(env.mongodb_uri);
  console.log(`Connected to database: ${mongoose.connection.db.databaseName}`);

  try {
    const landlord = await Landlord.findOne({ email }).select("email paymentMode").lean();
    if (!landlord) throw new Error(`No landlord found for ${email}`);
    const before = await load(landlord);

    if (command === "show") return print(before);

    if (before.mode === args.mode) {
      print(before);
      return console.log(`\nAlready ${args.mode}. Nothing to do.`);
    }
    if (args.mode === DIRECT && before.warnings.length) {
      console.log(`\nWarning: ${email} ${before.warnings.join(" and ")}.`);
      console.log("Those jobs still settle from the wallet. Refund any unused balance in Stripe by hand.");
    }
    await Landlord.updateOne({ _id: landlord._id }, { $set: { paymentMode: args.mode } });
    print(await load({ ...landlord, paymentMode: args.mode }));
    console.log(`\nSwitched to ${args.mode}. Jobs booked from now on use it; booked jobs keep their rail.`);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`\n[payment_mode] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, describe };
