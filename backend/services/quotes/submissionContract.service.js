const { ItemizationError, createQuoteSnapshot, reconcileLegacyTotals } = require("./itemization.service");
const own = (value, key) => Object.hasOwn(value || {}, key);
function contract(resource, body) {
  if (resource?.quoteContractVersion !== 2) {
    if (own(body, "itemization") || own(body, "quoteContractVersion")) throw new ItemizationError("itemization_not_enabled", "itemization");
    return false;
  }
  if (own(body, "quoteContractVersion") && body.quoteContractVersion !== 2) throw new ItemizationError("invalid_quote_contract", "quoteContractVersion");
  if (body?.expectedRevision !== 0) {
    const error = new ItemizationError("quote_revision_conflict", "expectedRevision");
    error.status = 409; throw error;
  }
  return true;
}
function initialQuote(resource, body) {
  if (!contract(resource, body)) return null;
  const snapshot = createQuoteSnapshot(body.itemization, { revision: 1 });
  const legacy = {};
  for (const key of ["quoteLow", "quoteHigh"]) if (own(body, key)) legacy[key] = body[key];
  const projection = reconcileLegacyTotals(snapshot.itemization, legacy);
  return { snapshot, ...projection };
}
function finalStatement(resource, body) {
  if (!contract(resource, body)) return null;
  const snapshot = createQuoteSnapshot(body.itemization, { revision: 1 });
  if (snapshot.itemization.pricingMode !== "fixed") throw new ItemizationError("final_statement_must_be_fixed", "pricingMode");
  reconcileLegacyTotals(snapshot.itemization, own(body, "actualCost") ? { actualCost: body.actualCost } : {});
  if (own(body, "invoiceReference") && (typeof body.invoiceReference !== "string" || body.invoiceReference.trim().length > 120)) {
    throw new ItemizationError("invalid_invoice_reference", "invoiceReference");
  }
  return { finalStatement: snapshot, actualCost: snapshot.itemization.totals.highMinor / 100,
    invoiceReference: body.invoiceReference?.trim() || null };
}
module.exports = { initialQuote, finalStatement };
