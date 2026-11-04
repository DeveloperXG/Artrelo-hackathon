const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// What a signed-in landlord or tenant told us through "Send feedback". Saved
// before it is emailed, like a Lead, so a mail outage costs a delivery and not
// the message: beta metrics show what people do, this is the only record of why.
const FeedbackSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    role: { type: String, enum: ["landlord", "property_manager", "admin", "tenant"], required: true },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    // The app path they were on, so "this page is confusing" means something.
    page: { type: String, trim: true, maxlength: 300 },
    emailedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Feedback", FeedbackSchema);
