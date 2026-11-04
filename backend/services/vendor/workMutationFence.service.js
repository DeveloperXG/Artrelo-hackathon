const Appointment = require('../../models/Appointment');
async function claim(appointment, now = new Date()) {
  // Missing legacy time bases cannot enter the new reschedule protocol anyway.
  if (appointment.bookingVersion !== 2 || !appointment.confirmedStart || !appointment.confirmedEnd) return true;
  const result = await Appointment.updateOne({ _id: appointment._id, landlordId: appointment.landlordId,
    requestId: appointment.requestId, status: { $in: ['scheduled', 'work_verifying'] },
    confirmedStart: appointment.confirmedStart, confirmedEnd: appointment.confirmedEnd },
  [{ $set: { workMutationStartedAt: { $ifNull: ['$workMutationStartedAt', now] } } }]);
  return result.matchedCount === 1;
}
module.exports = { claim };
