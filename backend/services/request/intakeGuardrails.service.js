// Shared open states. Admission is enforced transactionally in creationEligibility.service.
module.exports = { OPEN_REQUEST_STATUSES: require('./creationEligibility.service').OPEN };
