const mongoose = require("mongoose");
// Writing this identity-scoped row inside the booking transaction serializes
// overlapping checks across landlords. A read followed by insert is not a lock.
const schema = new mongoose.Schema({
  identityId: { type: mongoose.Schema.Types.ObjectId, ref: "VendorIdentity", required: true, unique: true },
  revision: { type: Number, default: 0 },
}, { timestamps: true });
module.exports = mongoose.model("VendorCalendar", schema);
