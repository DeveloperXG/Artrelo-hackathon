// The low-funds warning: when it fires, where it goes, and that it fires once.

const assert = require("assert");

const LandlordLedger = require("../../../models/LandlordLedger");
const LandlordPolicy = require("../../../models/LandlordPolicy");
const Landlord = require("../../../models/Landlord");
const { Notification } = require("../../../models/Notification");
const emailService = require("../../../services/notification/email.service");

let ledgerRow = null;
let policyRow = null;
let claimModified = 1;
let notifications = [];
let emails = [];
let ledgerUpdates = [];

LandlordLedger.findOne = (filter) => {
  const doc = ledgerRow;
  return {
    select: () => ({ lean: async () => doc }),
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
};
LandlordLedger.updateOne = async (filter, update) => {
  ledgerUpdates.push({ filter, update });
  return { modifiedCount: filter.lowBalanceNotifiedAt !== undefined ? claimModified : 1 };
};
LandlordPolicy.findOne = () => ({
  select: () => ({ lean: async () => policyRow }),
  lean: async () => policyRow,
});
Landlord.findById = () => ({ select: () => ({ lean: async () => ({ email: "owner@artrelo.test" }) }) });
Notification.create = async (row) => {
  notifications.push(row);
  return row;
};
emailService.sendEmail = async (message) => {
  emails.push(message);
  return { sent: true };
};

const {
  getLowFundsStatus,
  resolveThresholdCents,
  warnIfLowBalance,
} = require("../../../services/ledger/lowBalance.service");

const reset = ({ availableCents, notifiedAt = null, threshold = 100 }) => {
  ledgerRow = {
    _id: "ledger-1",
    available: availableCents,
    currency: "CAD",
    lowBalanceThresholdCents: 10000,
    lowBalanceNotifiedAt: notifiedAt,
  };
  policyRow = { lowFundsThreshold: threshold };
  claimModified = 1;
  notifications = [];
  emails = [];
  ledgerUpdates = [];
};

async function main() {
  /* -------- the threshold: policy first, ledger default otherwise -------- */
  assert.strictEqual(resolveThresholdCents({ lowFundsThreshold: 250 }, { lowBalanceThresholdCents: 10000 }), 25000);
  assert.strictEqual(resolveThresholdCents({ lowFundsThreshold: 0 }, { lowBalanceThresholdCents: 10000 }), 0, "0 is a choice");
  assert.strictEqual(resolveThresholdCents(null, { lowBalanceThresholdCents: 10000 }), 10000);

  /* -------- below the threshold: the bell AND an email -------- */
  reset({ availableCents: 4000 });
  let result = await warnIfLowBalance({ landlordId: "landlord-1" });
  assert.deepStrictEqual(result, { warned: true });
  assert.strictEqual(notifications.length, 1, "a notification in the bell");
  assert.match(notifications[0].message, /below your low-funds threshold of 100 CAD/);
  assert.strictEqual(emails.length, 1, "and an email -- it used to be bell-only");
  assert.strictEqual(emails[0].to, "owner@artrelo.test");

  /* -------- once a day per dip -------- */
  reset({ availableCents: 4000, notifiedAt: new Date() });
  result = await warnIfLowBalance({ landlordId: "landlord-1" });
  assert.strictEqual(result.reason, "recently_warned");
  assert.strictEqual(emails.length, 0);

  // Two holds landing together: the second loses the claim and sends nothing.
  reset({ availableCents: 4000 });
  claimModified = 0;
  result = await warnIfLowBalance({ landlordId: "landlord-1" });
  assert.strictEqual(result.reason, "recently_warned");
  assert.strictEqual(notifications.length, 0);

  /* -------- recovered: the next dip warns again -------- */
  reset({ availableCents: 50000, notifiedAt: new Date() });
  result = await warnIfLowBalance({ landlordId: "landlord-1" });
  assert.strictEqual(result.reason, "above_threshold");
  assert.deepStrictEqual(ledgerUpdates[0].update, { $set: { lowBalanceNotifiedAt: null } });

  /* -------- the Wallet's view -------- */
  reset({ availableCents: 4000 });
  assert.deepStrictEqual(await getLowFundsStatus({ landlordId: "landlord-1", availableCents: 4000 }), {
    threshold: 100,
    below: true,
  });
  assert.strictEqual((await getLowFundsStatus({ landlordId: "landlord-1", availableCents: 10000 })).below, false);

  console.log("lowBalance.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
