const { createProviderError } = require("../providerShapes.service");

function notConfigured() {
  throw createProviderError(
    "provider_not_configured",
    "Taskrabbit provider is not configured. Official integration access is required before implementation.",
    503
  );
}

class TaskrabbitProvider {
  constructor() {
    this.providerName = "taskrabbit";
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

module.exports = TaskrabbitProvider;
