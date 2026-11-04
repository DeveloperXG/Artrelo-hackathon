// Preloaded before every unit-test file (see run_unit.js).
//
// Unit tests must be hermetic: no real network. Stubbing fetch forces any
// OpenAI-backed path to throw and fall back to the deterministic logic, so the
// suite is fast, free, and deterministic on any Node version.
globalThis.fetch = () =>
  Promise.reject(new Error("network disabled in unit tests"));
