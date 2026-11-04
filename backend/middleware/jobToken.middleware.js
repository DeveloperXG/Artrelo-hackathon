// Gate for the vendor's completion surface.
//
// THE ORDERING IN THE ROUTER IS THE SECURITY PROPERTY. This runs BEFORE multer,
// so an invalid or retired token costs zero bytes. Put multer first and a
// leaked link becomes a way to stream 10MB into the process on every request
// before anything checks whether the caller is entitled to be there.
//
// Every failure returns the byte-identical GENERIC_NOT_FOUND body used by
// vendorPortal.controller, so a probe cannot distinguish "never existed" from
// "revoked" from "wrong job state".

const Appointment = require("../models/Appointment");
const JobCompletion = require("../models/JobCompletion");
const { resolveJobToken } = require("../services/vendor/jobToken.service");

// Must stay identical to vendorPortal.controller.js's GENERIC_NOT_FOUND.
const GENERIC_NOT_FOUND = {
  success: false,
  code: "invalid_link",
  message: "This link is not valid. It may have been replaced by a newer one.",
};

// The window during which a vendor may WRITE evidence. Bounded by the JOB's
// lifecycle rather than the token's: uploads are impossible before the tenant
// confirms the time and after the job closes, so even an indefinitely-leaked
// token has a finite abuse window.
const UPLOADABLE_APPOINTMENT_STATUSES = ["scheduled", "work_verifying"];

// READS are deliberately wider. A vendor whose submission landed in review has
// done the work and sent it in; showing them a dead link at that point is both
// alarming and wrong. They can still see "submitted, under review" — they just
// cannot change anything.
const READABLE_APPOINTMENT_STATUSES = [
  ...UPLOADABLE_APPOINTMENT_STATUSES,
  "in_review",
  "disputed",
];

function requireJobToken({ requireDraftCompletion = false, readOnly = false } = {}) {
  return async (req, res, next) => {
    try {
      const jobToken = await resolveJobToken(req.params.token);
      if (!jobToken) return res.status(404).json(GENERIC_NOT_FOUND);

      const appointment = await Appointment.findById(jobToken.appointmentId);
      if (!appointment) return res.status(404).json(GENERIC_NOT_FOUND);
      const allowed = readOnly ? READABLE_APPOINTMENT_STATUSES : UPLOADABLE_APPOINTMENT_STATUSES;
      if (!allowed.includes(appointment.status)) {
        return res.status(404).json(GENERIC_NOT_FOUND);
      }

      const completion = await JobCompletion.findOne({ appointmentId: appointment._id });

      // Anything already submitted is closed to further writes. Checked here
      // rather than in each handler so no future endpoint can forget it.
      if (requireDraftCompletion && completion && completion.status !== "draft") {
        return res.status(409).json({
          success: false,
          code: "already_submitted",
          message: "You have already submitted your completion report for this job.",
        });
      }

      req.jobToken = jobToken;
      req.appointment = appointment;
      req.jobCompletion = completion;
      return next();
    } catch (err) {
      console.error("[requireJobToken] error", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  };
}

module.exports = {
  requireJobToken,
  GENERIC_NOT_FOUND,
  UPLOADABLE_APPOINTMENT_STATUSES,
  READABLE_APPOINTMENT_STATUSES,
};
