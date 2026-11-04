const Vendor = require("../../../models/Vendor");
const {
  normalizeVendorOption,
  normalizePriceEstimate,
  normalizeBookingRequest,
  normalizeBookingResult,
} = require("../providerShapes.service");

class ManualDispatchProvider {
  constructor(options = {}) {
    this.vendorRepository = options.vendorRepository || Vendor;
    this.providerName = "manual_dispatch";
  }

  async searchVendors(requestContext = {}) {
    const landlordId = requestContext.landlordId || requestContext.request?.landlordId;
    if (!landlordId) return [];

    const rows = await this.vendorRepository
      .find({
        landlordId,
        source: "manual_dispatch",
        status: "active",
      })
      .lean();

    return rows.map((row) =>
      normalizeVendorOption({
        ...row,
        providerName: "manual_dispatch",
        providerVendorId: row.providerVendorId || row._id?.toString?.(),
      })
    );
  }

  async estimatePrice(requestContext = {}, vendorOption = {}) {
    const vendor = normalizeVendorOption(vendorOption);
    const base = Math.max(vendor.hourlyRate || 0, 0);
    return normalizePriceEstimate(
      {
        providerName: "manual_dispatch",
        providerVendorId: vendor.providerVendorId,
        amountLow: base,
        amountHigh: base ? base + 60 : 0,
        basis: "manual_dispatch_reference",
        confidence: "low",
        summary: "Reference estimate based on stored vendor profile.",
      },
      requestContext,
      vendor
    );
  }

  async getAvailability() {
    return [];
  }

  async createBooking(bookingRequest = {}) {
    const normalizedRequest = normalizeBookingRequest(bookingRequest);
    return normalizeBookingResult(
      {
        providerName: "manual_dispatch",
        providerVendorId: normalizedRequest.vendorOption.providerVendorId,
        bookingId: `manual-dispatch-${normalizedRequest.vendorOption.providerVendorId}`,
        status: "manual_dispatch_required",
        note: "Manual dispatch queued. No automated vendor outreach was sent.",
        isDemo: true,
      },
      normalizedRequest
    );
  }
}

module.exports = ManualDispatchProvider;
