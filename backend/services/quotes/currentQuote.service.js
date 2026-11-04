// Original scalar response is immutable evidence. All current-price consumers
// use the current server snapshot for v2; malformed v2 never falls back to it.
function currentQuote(outreach) {
  if (outreach?.quoteContractVersion !== 2) return { revision: null, hash: null,
    low: outreach?.response?.quoteLow ?? null, high: outreach?.response?.quoteHigh ?? null, snapshot: null };
  if (outreach.response?.outcome === "declined" && !outreach.currentQuoteRevision) return { revision: null, hash: null, low: null, high: null, snapshot: null };
  const snapshot = outreach.quoteRevisions?.find(row => row.revision === outreach.currentQuoteRevision);
  if (!snapshot?.hash || !snapshot.itemization?.totals) throw Object.assign(new Error("Current itemized quote is unavailable."),
    { statusCode: 409, code: "quote_revision_conflict" });
  return { revision: snapshot.revision, hash: snapshot.hash, low: snapshot.itemization.totals.lowMinor / 100,
    high: snapshot.itemization.totals.highMinor / 100, snapshot };
}
module.exports = { currentQuote };
