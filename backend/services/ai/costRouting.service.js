// Cost responsibility heuristics. AI triage suggests responsibility; this service
// computes a default cost split based on category + responsibility, which the
// landlord can override.

const SHARED_CATEGORIES = ["Appliance", "HVAC"]; // example shared
const TENANT_CAUSED_CATEGORIES = ["Pest", "Cleaning"]; // typically tenant
const LANDLORD_CATEGORIES = ["Plumbing", "Electrical", "Structural", "Safety/Emergency"];

function defaultResponsibility(category, aiSuggestion) {
  if (aiSuggestion && aiSuggestion !== "unknown") return aiSuggestion;
  if (LANDLORD_CATEGORIES.includes(category)) return "landlord";
  if (TENANT_CAUSED_CATEGORIES.includes(category)) return "tenant";
  if (SHARED_CATEGORIES.includes(category)) return "shared";
  return "unknown";
}

function computeSplit({ totalCost = 0, responsibility = "unknown" }) {
  if (!totalCost || totalCost <= 0) return { tenant: 0, landlord: 0, insurance: 0 };
  switch (responsibility) {
    case "tenant":
      return { tenant: totalCost, landlord: 0, insurance: 0 };
    case "landlord":
      return { tenant: 0, landlord: totalCost, insurance: 0 };
    case "shared":
      return {
        tenant: Math.round(totalCost * 0.5 * 100) / 100,
        landlord: Math.round(totalCost * 0.5 * 100) / 100,
        insurance: 0,
      };
    case "insurance":
      return { tenant: 0, landlord: 0, insurance: totalCost };
    default:
      return { tenant: 0, landlord: totalCost, insurance: 0 };
  }
}

module.exports = { defaultResponsibility, computeSplit };
