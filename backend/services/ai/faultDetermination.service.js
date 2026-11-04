const { aiTriage } = require("./categorization.service");
const { defaultResponsibility } = require("./costRouting.service");

// Light wrapper used by request controller to assign responsibility based on triage.
async function determineFault(input) {
  const triageResult = await aiTriage(input);
  const triage = triageResult?.triage || triageResult;
  const responsibility = defaultResponsibility(triage.category, triage.suggestedResponsibility);
  const normalizedTriage = { ...triage, suggestedResponsibility: responsibility };
  return {
    ...triageResult,
    triage: normalizedTriage,
  };
}

module.exports = { determineFault };
