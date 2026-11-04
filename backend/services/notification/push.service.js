// Push notification stub (in-app notification creation lives in notification.controller).
async function sendPush(/* { userId, title, body } */) {
  return { stub: true, delivered: false };
}
module.exports = { sendPush };
