// Which rail pays a vendor: the landlord directly, or Artrelo from the wallet.
//
// The ONLY place the two fields are interpreted, because each one's absence
// means something different and getting it backwards is a money bug:
//
//   Landlord.paymentMode     absent => DIRECT. New landlords pay vendors
//                            themselves until the operator switches them to
//                            platform payouts. A .lean() read skips the schema
//                            default, so the default cannot be relied on.
//   Appointment.paymentMode  absent => PLATFORM. An appointment written before
//                            the field existed was booked on the wallet rail and
//                            has a hold behind it; treating it as direct would
//                            strand that hold.
//
// Pure apart from loadLandlordPaymentMode.

const Landlord = require("../../models/Landlord");

const DIRECT = "direct";
const PLATFORM = "platform";

/** A landlord's mode for NEW bookings. */
function landlordPaymentMode(landlord) {
  return landlord?.paymentMode === PLATFORM ? PLATFORM : DIRECT;
}

/** The rail one job was booked on. */
function appointmentPaymentMode(appointment) {
  return appointment?.paymentMode === DIRECT ? DIRECT : PLATFORM;
}

const isDirectAppointment = (appointment) => appointmentPaymentMode(appointment) === DIRECT;

/** Read once, at the moment a booking is made. A missing landlord is direct: nothing to hold against. */
async function loadLandlordPaymentMode(landlordId) {
  if (!landlordId) return DIRECT;
  const landlord = await Landlord.findById(landlordId).select("paymentMode").lean();
  return landlordPaymentMode(landlord);
}

module.exports = {
  DIRECT,
  PLATFORM,
  landlordPaymentMode,
  appointmentPaymentMode,
  isDirectAppointment,
  loadLandlordPaymentMode,
};
