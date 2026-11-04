const { Notification } = require("../../models/Notification");
const Landlord = require("../../models/Landlord");
const Tenant = require("../../models/Tenant");
const env = require("../../config/env");
const { sendEmail } = require("./email.service");
const { publish } = require("../realtime/liveEvents.service");
const { buildNotificationEmail } = require("./templates/notificationEmail");

// WHICH NOTIFICATIONS ALSO GO BY EMAIL. The bell only reaches someone who has
// Artrelo open; these are the moments a person has to act, often against a
// clock (approvals expire in 24h, a tenant's silence auto-confirms a job in
// 48h), so they also land in the inbox. Everything else stays in-app.
//
// Decided here by type, rather than by an `email` argument at each call site,
// so a new place that raises one of these cannot forget to send it. A caller
// that passes its own `email` (a richer template) is respected and this is
// skipped. The recipient's email preference is honoured.
//
// path(meta) is where the person deals with it, relative to the app.
const toRequest = (base) => (meta) => (meta.workOrderId ? `${base}/requests/${meta.workOrderId}` : base);
const toDecisions = (meta) =>
  /^\/dashboard\//.test(meta.actionUrl || "") ? meta.actionUrl :
    meta.workOrderId ? `/dashboard/decisions?request=${meta.workOrderId}` : "/dashboard/decisions";
const EMAILED_TYPES = {
  landlord: {
    work_order_created: { buttonLabel: "Open the request", path: toRequest("/dashboard") },
    decision_needed: { buttonLabel: "Decide", path: toDecisions },
    vendor_outreach_exhausted: { buttonLabel: "Choose a vendor", path: toDecisions },
    vendor_no_show_reported: { buttonLabel: "Re-route the job", path: toDecisions },
    appointment_unconfirmed: { buttonLabel: "Confirm or re-route", path: toDecisions },
    maintenance_verification_disputed: { buttonLabel: "Open the request", path: toRequest("/dashboard") },
    request_appeal_submitted: { buttonLabel: "Review the appeal", path: toRequest("/dashboard") },
    payment_overdue: { buttonLabel: "Open your wallet", path: () => "/dashboard/wallet" },
    payment_failed: { buttonLabel: "Open your wallet", path: () => "/dashboard/wallet" },
    vendor_payment_due: { buttonLabel: "Mark it paid", path: () => "/dashboard/wallet" },
  },
  tenant: {
    maintenance_scheduled: { buttonLabel: "Open your request", path: toRequest("/portal") },
    appointment_reminder: { buttonLabel: "Confirm the time", path: toRequest("/portal") },
    appointment_confirmed: { buttonLabel: "Open your request", path: toRequest("/portal") },
    maintenance_verification_requested: { buttonLabel: "Confirm the repair", path: toRequest("/portal") },
  },
};

/** Who a notification's userId is: a landlord or a tenant profile. */
async function findRecipient(userId) {
  const fields = "email firstName notificationPreferences";
  const landlord = await Landlord.findById(userId).select(fields).lean();
  if (landlord) return { audience: "landlord", person: landlord };
  const tenant = await Tenant.findById(userId).select(fields).lean();
  return tenant ? { audience: "tenant", person: tenant } : null;
}

/**
 * Email a notification that needs a person, if its type is one of those above.
 * Never throws: the in-app row is already written and is the record.
 */
async function emailIfNeeded({ userId, type, title, message, metadata }) {
  try {
    const recipient = await findRecipient(userId);
    const rule = recipient && EMAILED_TYPES[recipient.audience][type];
    if (!rule) return;
    const { person, audience } = recipient;
    if (!person.email || person.notificationPreferences?.email === false) return;
    const base = String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "");
    const email = buildNotificationEmail({
      title,
      message,
      url: `${base}${rule.path(metadata || {})}`,
      buttonLabel: rule.buttonLabel,
      emergency: metadata?.priority === "emergency",
      firstName: person.firstName,
      audience,
    });
    await sendEmail({ to: person.email, ...email, categories: [`notify_${type}`] });
  } catch (err) {
    console.error("[notifyUser] email failed", type, err.message);
  }
}

// Fold another event into this user's existing UNREAD row of the same type for
// the same request, instead of adding a row per event. A chatty thread is one
// bell entry that counts up ("sent 3 new messages") and floats back to the top;
// once it is read, the next event starts a fresh row.
//
// createdAt is bumped so the row sorts as new (the bell orders by it), which
// needs overwriteImmutable: Mongoose otherwise drops writes to timestamps.
async function coalesceInto({ userId, type, title, titleForCount, message, metadata }) {
  const now = new Date();
  const row = await Notification.findOneAndUpdate(
    { userId, type, read: false, "metadata.workOrderId": String(metadata.workOrderId) },
    { $set: { message, createdAt: now, updatedAt: now }, $inc: { "metadata.count": 1 } },
    { new: true, timestamps: false, overwriteImmutable: true }
  );
  if (!row) return null;
  const count = row.metadata?.count || 1;
  const nextTitle = typeof titleForCount === "function" ? titleForCount(count) : title;
  if (nextTitle && nextTitle !== row.title) {
    // Guarded on the count it was computed from, so two racing events can't
    // leave the smaller count in the title.
    await Notification.updateOne({ _id: row._id, "metadata.count": count }, { $set: { title: nextTitle } });
    row.title = nextTitle;
  }
  return row;
}

async function notifyUser({
  userId,
  type = "system_maintenance",
  title,
  message,
  metadata = {},
  email,
  emailSubject,
  // Optional rich email. Without it the in-app message is sent as plain text.
  emailHtml,
  emailText,
  emailCategory,
  // Merge into an unread row for the same request (needs metadata.workOrderId).
  coalesce = false,
  titleForCount,
  eventKey,
}) {
  try {
    const inAppOnly = require('../judgeSandbox/offlineGuard.service').inAppOnly();
    if (inAppOnly) {
      const simulated = metadata.simulated === true || require('../judgeSandbox/simulationScope.service').notificationSimulation(userId);
      metadata = { ...metadata, sandbox: true, simulated };
      title = `Sandbox${simulated ? ' · Simulated vendor' : ''} · ${title}`.slice(0, 200);
    }
    let notification = null;
    if (eventKey) {
      // Returning the pre-update document makes insertion ownership atomic.
      const existing = await Notification.findOneAndUpdate({ eventKey }, { $setOnInsert: {
        eventKey, userId, type, title, message, metadata,
      } }, { upsert: true, new: false });
      if (existing) return existing;
      notification = await Notification.findOne({eventKey});
    }
    if (!notification && coalesce && metadata.workOrderId) {
      notification = await coalesceInto({ userId, type, title, titleForCount, message, metadata });
    }
    if (!notification) {
      notification = await Notification.create({
        userId,
        type,
        title,
        message,
        metadata: coalesce ? { ...metadata, count: 1 } : metadata,
      });
    }
    // After the write, so a client that refetches on the nudge finds the row.
    publish(userId, "notifications");
    // A genuine isolated bootstrap selects this capability, never an HTTP
    // field or production environment flag. Persisted bell + SSE still run.
    if (inAppOnly) return notification;
    if (email) {
      await sendEmail({
        to: email,
        subject: emailSubject || title,
        text: emailText || message,
        ...(emailHtml ? { html: emailHtml } : {}),
        ...(emailCategory ? { categories: [emailCategory] } : {}),
      });
    } else if (notification.metadata?.count === undefined || notification.metadata.count <= 1) {
      // Not for an event folded into an existing unread row: the first one
      // already went out, and a chatty thread must not become a chatty inbox.
      await emailIfNeeded({ userId, type, title, message, metadata });
    }
    return notification;
  } catch (err) {
    console.error("[notifyUser] failed", err.message);
    return null;
  }
}

module.exports = { notifyUser, EMAILED_TYPES };
