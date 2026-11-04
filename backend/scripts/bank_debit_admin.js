// Operator control over bank top-ups (Canadian pre-authorized debit).
//
//   node scripts/bank_debit_admin.js list
//   node scripts/bank_debit_admin.js unblock --email dana@example.com
//
// Against production, from backend/:
//
//   railway run node scripts/bank_debit_admin.js list
//
// A disputed bank top-up PAUSES bank top-ups for that landlord (a PAD dispute
// cannot be contested, so the only defence against a repeat is not to debit
// again). Lifting the pause is a decision a person makes after talking to the
// landlord -- a script, not a screen. Card top-ups are never paused.
//
// `list` shows every landlord who has used bank top-ups: their saved account,
// the pause, what they owe on bank top-ups (bank_owed), and their top-ups by status.

const mongoose = require("mongoose");

const env = require("../config/env");
const Landlord = require("../models/Landlord");
const LandlordLedger = require("../models/LandlordLedger");
const WalletTopUp = require("../models/WalletTopUp");
const { normalizeEmail } = require("../services/auth/account.service");
const { fromCents } = require("../services/ledger/money");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) continue;
    args[arg.slice(2)] = value;
    i += 1;
  }
  return args;
}

const day = (date) => (date ? new Date(date).toISOString().slice(0, 10) : "-");

/** Pure: one table row per landlord. Exported for tests. */
function toRow(landlord, { counts = {}, bankOwedCents = 0 } = {}) {
  const bank = landlord.bankDebit || {};
  return {
    email: landlord.email,
    saved_bank: bank.paymentMethodId ? `${bank.institution || "bank"} ••${bank.last4 || "????"}` : "-",
    paused: bank.blockedAt ? `since ${day(bank.blockedAt)} (${bank.blockedReason || "no reason"})` : "no",
    owed_on_bank: `$${fromCents(bankOwedCents).toFixed(2)}`,
    cleared: counts.succeeded || 0,
    processing: counts.processing || 0,
    failed: counts.failed || 0,
    disputed: counts.disputed || 0,
  };
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!["list", "unblock"].includes(command)) throw new Error("Unknown or missing command (list | unblock --email <email>)");
  if (command === "unblock" && !normalizeEmail(args.email || "")) throw new Error("--email is required");

  await mongoose.connect(env.mongodb_uri);
  console.log(`Connected to database: ${mongoose.connection.db.databaseName}`);

  try {
    if (command === "list") {
      const topUps = await WalletTopUp.find({}).select("landlordId status").lean();
      const byLandlord = new Map();
      for (const row of topUps) {
        const key = String(row.landlordId);
        if (!byLandlord.has(key)) byLandlord.set(key, {});
        const counts = byLandlord.get(key);
        counts[row.status] = (counts[row.status] || 0) + 1;
      }
      const landlords = await Landlord.find({
        $or: [{ _id: { $in: [...byLandlord.keys()] } }, { "bankDebit.paymentMethodId": { $exists: true } }, { "bankDebit.blockedAt": { $exists: true } }],
      })
        .select("email bankDebit")
        .sort({ createdAt: 1 })
        .lean();
      if (!landlords.length) return console.log("\nNo landlord has used bank top-ups yet.");
      const ledgers = await LandlordLedger.find({ landlordId: { $in: landlords.map((l) => l._id) } }).select("landlordId bankOwed").lean();
      const owed = new Map(ledgers.map((l) => [String(l.landlordId), l.bankOwed || 0]));
      return console.table(
        landlords.map((l) => toRow(l, { counts: byLandlord.get(String(l._id)), bankOwedCents: owed.get(String(l._id)) }))
      );
    }

    const email = normalizeEmail(args.email);
    const landlord = await Landlord.findOne({ email }).select("email bankDebit").lean();
    if (!landlord) throw new Error(`No landlord found for ${email}`);
    if (!landlord.bankDebit?.blockedAt) return console.log(`\n${email}: bank top-ups are not paused. Nothing to do.`);

    console.log(`\n${email}`);
    console.log(`  paused since ${day(landlord.bankDebit.blockedAt)} (${landlord.bankDebit.blockedReason || "no reason"})`);
    await Landlord.updateOne(
      { _id: landlord._id },
      { $unset: { "bankDebit.blockedAt": 1, "bankDebit.blockedReason": 1 } }
    );
    console.log("  bank top-ups resumed. Their cap and one-at-a-time rule still apply until their top-ups clear.");
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`\n[bank_debit_admin] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, toRow, parseArgs };
