const Notification = require("../models/Notification").Notification;
const Landlord = require("../models/Landlord");
const { isOfferOpen } = require("../services/beta/beta.service");
const { publish } = require("../services/realtime/liveEvents.service");

// Notification types a landlord cannot delete while the founding offer is open
// (neither accepted nor declined). The bell has no delete control, so this does
// not change what anyone sees -- it closes the API route that would otherwise
// let a landlord clear the offer out of sight with a hand-built request. The
// pinned "founding offer" row in the bell is computed live and so cannot be
// deleted at all; this protects the stored reminders that sit beside it.
const OFFER_PINNED_TYPES = ["beta_reminder"];

/**
 * The types this caller may NOT delete right now. Empty for tenants, and for a
 * landlord whose offer is resolved: once they accept or decline, the reminders
 * are ordinary notifications again.
 */
async function pinnedTypesFor(user) {
  if (user?.role !== "landlord") return [];
  const landlord = await Landlord.findById(user.id).select("beta foundingAgreement").lean();
  return isOfferOpen(landlord) ? OFFER_PINNED_TYPES : [];
}

// Newest first, capped. The bell asks for a handful; nothing should be able to
// pull a user's entire history in one response.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

exports.getNotifications = async (req, res, next) => {
  try {
    const requested = Number.parseInt(req.query?.limit, 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

    // unreadCount is over ALL of the user's notifications, not just this page,
    // so the bell's dot is right even when the unread ones are older than the
    // newest `limit`.
    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ userId: req.user.id, read: false }),
    ]);

    return res.json({ success: true, notifications, unreadCount });
  } catch (err) {
    console.log(err);
    res.status(500).json({
      success: false,
      message: "Server error: Failed to retrieve notifications",
    });
  }
};

exports.getNotification = async (req, res, next) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findOne({
      userId: req.user.id,
      _id: id,
    });
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification does not exist" });
    }
    return res.json({ success: true, notification });
  } catch (err) {
    console.log(err);
    res.status(500).json({
      success: false,
      message: "Server error: Failed to retrieve notification",
    });
  }
};

exports.markAllRead = async (req, res, next) => {
  try {
    // Only the unread ones, so an old notification keeps the readAt it got
    // when it was actually read.
    const result = await Notification.updateMany(
      { userId: req.user.id, read: false },
      { $set: { read: true, readAt: Date.now() } }
    );
    // Other tabs refetch their own authoritative unread count after this write.
    if (result.modifiedCount > 0) publish(req.user.id, "notifications");

    res.json({
      success: true,
      message: "All notifications marked as read",
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Server Error: Failed to mark notifications as read",
    });
  }
};

// Mark notification as read
exports.markRead = async (req, res, next) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId: req.user.id },
      { $set: { read: true, readAt: Date.now() } },
      { new: true }
    );

    if (!notification)
      return res
        .status(404)
        .json({ success: false, message: "Notification not found" });

    publish(req.user.id, "notifications");
    res.json({
      success: true,
      updatedNotification: {
        type: notification.type,
        title: notification.title,
        read: notification.read,
        readAt: notification.readAt,
      },
      message: "Notification marked as read",
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({
      success: false,
      message: "Server error: Failed to mark notification as read",
    });
  }
};

exports.deleteNotification = async (req, res, next) => {
  try {
    const pinned = await pinnedTypesFor(req.user);

    // findOneAndDelete, not findByIdAndDelete: the latter takes an id, and
    // handed this filter it matched on _id alone — any signed-in user could
    // delete anyone's notification by id.
    const deleted = await Notification.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id,
      ...(pinned.length ? { type: { $nin: pinned } } : {}),
    });

    if (!deleted) {
      // Distinguish "not yours / not there" from "yours, but pinned", so the
      // caller learns why rather than assuming it is gone.
      if (pinned.length && (await Notification.exists({ _id: req.params.id, userId: req.user.id, type: { $in: pinned } }))) {
        return res.status(409).json({
          success: false,
          code: "pinned_notification",
          message: "This reminder stays until you accept or decline the founding offer.",
        });
      }
      return res.status(404).json({
        success: false,
        message: "Notification not found or not authorized",
      });
    }

    publish(req.user.id, "notifications");
    res.json({
      success: true,
      message: "Notification deleted successfully",
      deletedNotification: deleted,
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({
      success: false,
      message: "Server error: Failed to delete notification",
    });
  }
};

exports.deleteNotifications = async (req, res, next) => {
  try {
    const pinned = await pinnedTypesFor(req.user);
    const result = await Notification.deleteMany({
      userId: req.user.id,
      // Keep the pinned ones rather than failing the whole call: "clear all"
      // should clear everything it is allowed to.
      ...(pinned.length ? { type: { $nin: pinned } } : {}),
    });
    const kept = pinned.length ? await Notification.countDocuments({ userId: req.user.id, type: { $in: pinned } }) : 0;

    if (result.deletedCount === 0)
      return res.json({ message: "No notifications to delete", ...(kept ? { kept } : {}) });
    publish(req.user.id, "notifications");
    return res.json({
      success: true,
      message: `Deleted ${result.deletedCount} notifications`,
      ...(kept ? { kept } : {}),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: "Server error: Failed to delete all notifications",
    });
  }
};
