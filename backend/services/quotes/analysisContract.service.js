const { createHash } = require("node:crypto");
const { calculateQuoteDeltas } = require("./itemization.service");
const FLAG_CODES = Object.freeze(["unclear", "possible_duplicate", "unsupported_basis", "scope_mismatch", "estimate_invoice_delta"]);
const RECOMMENDATIONS = ["clarify", "landlord_review", "no_additional_flags"];
const text = (value, cap) => typeof value === "string" ? value.slice(0, cap) : "";
const safeText = (value, cap) => text(value, cap)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[contact removed]")
  .replace(/(?:\+?\d[\d ().-]{8,}\d)/g, "[contact removed]");
const id = value => String(value?._id || value || "");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key));
const boundedText = (value, cap) => typeof value === "string" && value.trim().length > 0 && value.length <= cap;
const refList = (value, allowed, cap) => Array.isArray(value) && value.length <= cap &&
  value.every(ref => typeof ref === "string" && allowed.has(ref)) && new Set(value).size === value.length;

/** Pure projection: caller must load these records under authenticated ownership. */
function buildAnalysisContext({ request, snapshot, stage, agreedMinor = null, originalSnapshot = null, history = [], clarification }) {
  if (!["quote", "invoice"].includes(stage) || !snapshot?.hash || !snapshot.itemization || !id(request)) {
    throw new TypeError("Missing owned analysis basis");
  }
  const requestRef = `request:${id(request)}`;
  const quoteRef = `quote:${snapshot.hash}`;
  // No full documents, access credentials, raw audit payloads or contact fields.
  const context = { schemaVersion: 1, stage, request: { ref: requestRef,
    title: safeText(request.ai?.shortTitle || request.issueTitle, 240),
    summary: safeText(request.incidentRecord?.summary || request.ai?.summary, 1600),
    category: safeText(request.category, 80), scope: safeText(request.approvedScope?.description, 1000) || null },
    quote: { ref: quoteRef, revision: snapshot.revision, hash: snapshot.hash,
      pricingMode: snapshot.itemization.pricingMode, currency: snapshot.itemization.currency,
      totals: { ...snapshot.itemization.totals },
      items: snapshot.itemization.items.map(line => ({ ...line, description: safeText(line.description, 240) })) },
    history: history.slice(0, 3).map(job => ({ ref: `job:${id(job)}`,
      workPerformed: safeText(job.report?.workPerformed, 500),
      finalMinor: Number.isSafeInteger(job.closeRecovery?.payableCents) ? job.closeRecovery.payableCents : null })),
    historyKnown: history.length > 0,
    approvedScopeKnown: Boolean(request.approvedScope?.description || originalSnapshot),
    ...(clarification ? { clarification: { questions: clarification.questions.map(question => ({ id: question.id,
      code: question.code, lineIds: question.lineIds })), answers: clarification.answers.map(answer => ({
      questionId: answer.questionId, answer: safeText(answer.answer, 800) })) } } : {}),
    deltas: calculateQuoteDeltas({ agreedMinor,
      ...(originalSnapshot ? { originalLowMinor: originalSnapshot.itemization.totals.lowMinor,
        originalHighMinor: originalSnapshot.itemization.totals.highMinor } : {}),
      finalMinor: stage === "invoice" ? snapshot.itemization.totals.highMinor : null }),
  };
  return { context, contextHash: hash(context), sourceRefs: [requestRef, quoteRef, ...context.history.map(job => job.ref)] };
}

/** Model output is advisory data. No approval, money or executable fields accepted. */
function inspectAnalysis(value, basis) {
  const reject = reason => ({ analysis: null, reason });
  const lineIds = new Set(basis.context.quote.items.map(line => line.lineId));
  const sources = new Set(basis.sourceRefs);
  if (!exact(value, ["schemaVersion", "summary", "flags", "questions", "reviewRecommendation"]) || value.schemaVersion !== 1 ||
      !boundedText(value.summary, 800) || !RECOMMENDATIONS.includes(value.reviewRecommendation) ||
      !Array.isArray(value.flags) || value.flags.length > 8 || !Array.isArray(value.questions) || value.questions.length > 4) return reject('invalid_shape');
  for (const flag of value.flags) {
    if (!exact(flag, ["code", "lineIds", "sourceRefs", "explanation"]) || !boundedText(flag.explanation, 200)) return reject('invalid_flag_shape');
    if (!FLAG_CODES.includes(flag.code)) return reject('invalid_flag_code');
    if (!refList(flag.lineIds, lineIds, 50)) return reject('invalid_line_reference');
    if (!refList(flag.sourceRefs, sources, 8) || !flag.sourceRefs.length) return reject('invalid_source_reference');
  }
  for (const question of value.questions) {
    if (!exact(question, ["code", "lineIds", "suggestedQuestion"]) || !boundedText(question.suggestedQuestion, 240)) return reject('invalid_question_shape');
    if (!FLAG_CODES.includes(question.code)) return reject('invalid_question_code');
    if (!refList(question.lineIds, lineIds, 50)) return reject('invalid_line_reference');
  }
  if ((value.flags.length || value.questions.length) && value.reviewRecommendation === "no_additional_flags") return reject('inconsistent_recommendation');
  // Numeric claims must come from supplied facts; semantic quality still needs
  // a bounded live evaluation. Reject ungrounded numbers instead of guessing.
  const numbers = new Set(["0", "1", "2", "3"]);
  const collect = node => {
    if (typeof node === "number" && Number.isFinite(node)) {
      numbers.add(String(node)); numbers.add(String(node / 100)); numbers.add((node / 100).toFixed(2));
    } else if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object") Object.values(node).forEach(collect);
  };
  collect(basis.context.quote.totals);
  basis.context.quote.items.forEach(line => collect({ amountMinor: line.amountMinor, lowMinor: line.lowMinor, highMinor: line.highMinor }));
  collect(basis.context.deltas); collect(basis.context.history.map(job => job.finalMinor));
  const prose = [value.summary, ...value.flags.map(flag => flag.explanation), ...value.questions.map(question => question.suggestedQuestion)].join(" ");
  const claims = prose.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/g) || [];
  if (claims.some(number => !numbers.has(number.replaceAll(",", "")))) return reject('unsupported_number');
  // Cents and percentages cannot be silently relabelled as CAD amounts.
  const monetary = new Set();
  const amount = value => { if (typeof value === "number" && Number.isFinite(value)) {
    monetary.add(String(value / 100)); monetary.add((value / 100).toFixed(2));
  } };
  Object.values(basis.context.quote.totals).forEach(amount);
  basis.context.quote.items.forEach(line => [line.amountMinor, line.lowMinor, line.highMinor].forEach(amount));
  amount(basis.context.deltas.agreedMinor); amount(basis.context.deltas.finalMinor);
  Object.values(basis.context.deltas.finalVsEstimate || {}).forEach(amount);
  amount(basis.context.deltas.finalVsAgreed?.amountMinor);
  basis.context.history.forEach(job => amount(job.finalMinor));
  for (const match of prose.matchAll(/(?:CAD\s*|\$)(-?\d+(?:,\d{3})*(?:\.\d+)?)|(-?\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:CAD\b|dollars?\b)/gi)) {
    if (!monetary.has((match[1] || match[2]).replaceAll(",", ""))) return reject('unsupported_money');
  }
  return { analysis: JSON.parse(JSON.stringify(value)), reason: null };
}
// Preserve the existing closed validator's acceptance and return contract.
function validateAnalysis(value, basis) { return inspectAnalysis(value, basis).analysis; }

/** Deterministic development fixture, visibly labelled; never real model inference. */
function developmentAnalysis() {
  return { schemaVersion: 1, summary: "Development simulation: review the submitted breakdown and recorded scope before proceeding.",
    flags: [], questions: [], reviewRecommendation: "landlord_review" };
}

module.exports = { FLAG_CODES, buildAnalysisContext, validateAnalysis, inspectAnalysis, developmentAnalysis };
