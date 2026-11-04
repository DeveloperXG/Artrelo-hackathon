// Deliberately excludes identity values and inquiry/resource tokens.
function summarizeRequirements(account) {
  const current = account.requirements || {};
  const entries = current.entries || [];
  return {
    accountId: account.id,
    transfers: account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers || account.capabilities?.transfers || null,
    requirements: entries.map((entry) => ({
      description: entry.description,
      awaitingActionFrom: entry.awaiting_action_from,
      deadline: entry.minimum_deadline?.status,
      errors: (entry.errors || []).map((error) => ({ code: error.code, description: error.description })),
    })),
    currentlyDue: current.currently_due || [],
    pastDue: current.past_due || [],
    pendingVerification: current.pending_verification || [],
    disabledReason: current.disabled_reason || null,
    errors: (current.errors || []).map((error) => ({ code: error.code, requirement: error.requirement })),
  };
}

function normalizeBusinessWebsite(value) {
  if (!value) return null;
  if (typeof value !== "string" || value.length > 2048) throw new Error("Enter your business website URL.");
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a complete business website URL, starting with https://."); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".") || /^(localhost|127\.|0\.|192\.168\.|10\.)/.test(url.hostname)) {
    throw new Error("Enter your public business website URL, starting with https://.");
  }
  return url.href;
}

module.exports = { summarizeRequirements, normalizeBusinessWebsite };
