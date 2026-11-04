// One-off: give every existing Landlord and Tenant an Account.
//
//   node scripts/backfill_accounts.js --dry-run
//   node scripts/backfill_accounts.js
//
// RUN THIS BEFORE BOOTING THE NEW CODE against a database that already has
// users. Landlord and Tenant now require `accountId`, so any save of an
// un-backfilled document fails validation, and Mongoose cannot build the new
// unique index while those documents are missing the field (several nulls
// collide) — it only logs that failure, so the index would quietly not exist.
//
// Production needs none of this (it has no users), but running it there is
// harmless: it skips documents that already have an accountId, so it is safe
// to re-run.
const mongoose = require("mongoose");

const env = require("../config/env");
const Account = require("../models/Account");
const Landlord = require("../models/Landlord");
const Tenant = require("../models/Tenant");

const normalize = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

// Pure, so the interesting part is testable without a database.
//
// The case worth thinking about: the same address exists in BOTH collections,
// which is exactly the split this refactor removes. Those two rows are one
// person with one identity now, so they share one Account — and if they had
// different passwords, only one can survive. The landlord's is kept, because
// it is the account that owns data; the tenant is told to reset. Both are
// reported, never silently merged.
function planBackfill(landlords = [], tenants = []) {
  const accounts = new Map(); // email -> { email, hashedPassword, from }
  const assignments = []; // { kind, id, email }
  const warnings = [];
  const skipped = [];

  const consider = (doc, kind) => {
    if (doc.accountId) {
      skipped.push({ kind, id: String(doc._id), reason: "already has accountId" });
      return;
    }
    const email = normalize(doc.email);
    if (!email) {
      warnings.push(`${kind} ${doc._id} has no email; skipped`);
      return;
    }
    if (!doc.hashedPassword) {
      warnings.push(`${kind} ${doc._id} (${email}) has no password hash; skipped`);
      return;
    }

    const existing = accounts.get(email);
    if (!existing) {
      accounts.set(email, { email, hashedPassword: doc.hashedPassword, from: kind });
    } else if (existing.hashedPassword !== doc.hashedPassword) {
      // Landlord wins regardless of which was seen first.
      const keep = kind === "landlord" ? kind : existing.from;
      if (kind === "landlord") accounts.set(email, { email, hashedPassword: doc.hashedPassword, from: kind });
      warnings.push(
        `${email} exists as both landlord and tenant with DIFFERENT passwords; keeping the ${keep} password. The other role must reset it.`
      );
    } else {
      warnings.push(`${email} exists as both landlord and tenant with the same password; merged into one account.`);
    }

    assignments.push({ kind, id: String(doc._id), email });
  };

  landlords.forEach((doc) => consider(doc, "landlord"));
  tenants.forEach((doc) => consider(doc, "tenant"));

  return { accounts: [...accounts.values()], assignments, warnings, skipped };
}

async function backfillAccounts({ dryRun = false } = {}) {
  if (!env.mongodb_uri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(env.mongodb_uri);
  console.log(`Connected to database: ${mongoose.connection.db.databaseName}`);

  try {
    // Read through the NATIVE collection, not Mongoose.
    //
    // hashedPassword is no longer in either schema, and a Mongoose query will
    // not return a path the schema does not declare — `.select("+field")` only
    // un-hides a field marked select:false. Asking Mongoose gave back every
    // document with hashedPassword undefined, which this script would have
    // read as "no password" and skipped. Every one of them. Silently.
    const readProfiles = (Model) =>
      Model.collection
        .find({}, { projection: { email: 1, hashedPassword: 1, accountId: 1 } })
        .toArray();

    const [landlords, tenants] = await Promise.all([readProfiles(Landlord), readProfiles(Tenant)]);
    console.log(`Found ${landlords.length} landlord(s) and ${tenants.length} tenant(s)`);

    const plan = planBackfill(landlords, tenants);
    console.log(
      `Plan: ${plan.accounts.length} account(s), ${plan.assignments.length} profile link(s), ${plan.skipped.length} skipped`
    );
    plan.warnings.forEach((warning) => console.warn(`  ! ${warning}`));

    if (dryRun) {
      console.log("--dry-run: nothing written");
      return plan;
    }

    const idByEmail = new Map();
    for (const account of plan.accounts) {
      // Re-runnable: an account may already exist from an earlier pass.
      const existing = await Account.findOne({ email: account.email }).select("_id");
      if (existing) {
        idByEmail.set(account.email, existing._id);
        continue;
      }
      const created = await Account.create({
        email: account.email,
        hashedPassword: account.hashedPassword,
      });
      idByEmail.set(account.email, created._id);
    }
    console.log(`Accounts ready: ${idByEmail.size}`);

    // Native collection writes, not Mongoose: hashedPassword is absent from
    // both schemas now, and strict mode drops an $unset for a path it does not
    // know about — the field would stay behind forever.
    let linked = 0;
    for (const { kind, id, email } of plan.assignments) {
      const collection = (kind === "landlord" ? Landlord : Tenant).collection;
      await collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { accountId: idByEmail.get(email) }, $unset: { hashedPassword: "" } }
      );
      linked += 1;
    }
    console.log(`Linked ${linked} profile(s) and removed their password hashes`);

    // Build the new indexes now that every document can satisfy them.
    // createIndexes, never syncIndexes: syncIndexes DROPS indexes it does not
    // find in the schema.
    await Promise.all([Account.createIndexes(), Landlord.createIndexes(), Tenant.createIndexes()]);
    console.log("Indexes created");

    return plan;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  backfillAccounts({ dryRun: process.argv.includes("--dry-run") }).catch((err) => {
    console.error("[backfill_accounts]", err);
    process.exitCode = 1;
  });
}

module.exports = { backfillAccounts, planBackfill, normalize };
