const { createProviderError } = require("../providerShapes.service");

function notConfigured() {
  throw createProviderError(
    "provider_not_configured",
    "Thumbtack provider is not configured. Official integration access is required before implementation.",
    503
  );
}

class ThumbtackProvider {
  constructor() {
    this.providerName = "thumbtack";
  }

  async searchVendors() {
    notConfigured();
  }

  async estimatePrice() {
    notConfigured();
  }

  async getAvailability() {
    notConfigured();
  }

  async createBooking() {
    notConfigured();
  }
}

module.exports = ThumbtackProvider;
