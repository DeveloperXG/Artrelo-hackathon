const ManualDispatchProvider = require("./ManualDispatchProvider");
const TaskrabbitProvider = require("./TaskrabbitProvider");
const ThumbtackProvider = require("./ThumbtackProvider");
const { createProviderError } = require("../providerShapes.service");

// Recommendations come only from vendors a landlord put in their own network.
// The mock provider (a seeded demo directory with fabricated prices and slots)
// is gone, so "mock" is now an unknown provider rather than a disabled one.
// Taskrabbit/Thumbtack remain as unconfigured stubs for a future auto-find.
function parseEnabledProviders(rawValue) {
  return String(rawValue || "manual_dispatch")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function buildProviderMap(options = {}) {
  return {
    manual_dispatch:
      options.manualDispatchProvider || new ManualDispatchProvider(options.manualDispatchOptions),
    taskrabbit: options.taskrabbitProvider || new TaskrabbitProvider(),
    thumbtack: options.thumbtackProvider || new ThumbtackProvider(),
  };
}

function createVendorProviderRegistry(options = {}) {
  const env = options.env || process.env;
  const providers = options.providers || buildProviderMap(options);
  const enabledProviders = parseEnabledProviders(env.VENDOR_PROVIDER_ENABLED);
  const defaultProviderName = String(env.VENDOR_PROVIDER_DEFAULT || "manual_dispatch")
    .trim()
    .toLowerCase();

  function getVendorProvider(providerName) {
    const normalizedName = String(providerName || defaultProviderName).trim().toLowerCase();
    const provider = providers[normalizedName];

    if (!provider) {
      throw createProviderError(
        "unknown_provider",
        `Unknown vendor provider: ${normalizedName}`,
        400
      );
    }

    if (!enabledProviders.includes(normalizedName)) {
      throw createProviderError(
        "provider_not_configured",
        `Vendor provider is disabled: ${normalizedName}`,
        503
      );
    }

    return provider;
  }

  return {
    getVendorProvider,
    getEnabledProviders() {
      return enabledProviders.slice();
    },
    getDefaultProvider() {
      return getVendorProvider(defaultProviderName);
    },
    getDefaultProviderName() {
      return defaultProviderName;
    },
  };
}

module.exports = createVendorProviderRegistry();
module.exports.createVendorProviderRegistry = createVendorProviderRegistry;
module.exports.parseEnabledProviders = parseEnabledProviders;
