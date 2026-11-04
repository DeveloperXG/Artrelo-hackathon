const Request = require("../../models/MaintenanceRequest");
const OPEN = ["queued", "approved", "assigned", "in_progress"];
const ASSETS = {
  sink: /\bsink|\btap\b|\bfaucet\b/i,
  toilet: /\btoilet\b/i,
  shower: /\bshower\b/i,
  fridge: /\bfridge|\brefrigerator|\bfreezer/i,
  oven: /\boven|\bstove|\bcooktop/i,
  dishwasher: /\bdishwasher/i,
  washer: /\bwasher|\bwashing machine/i,
  dryer: /\bdryer/i,
  outlet: /\boutlet|\bsocket/i,
  furnace: /\bfurnace|\bheater|\bheating|\bno heat/i,
  ac: /\bair condition|\bcooling|\bno ac\b/i,
  door: /\bdoor|\bdeadbolt|\block\b/i,
  ceiling: /\bceiling|\broof/i,
};
const SYMPTOMS = {
  leak: /leak|drip/i,
  drainage: /clog|block|back.?up|drain.*slow|won.t drain/i,
  power:
    /no power|not (?:turn|work)|won.t (?:turn|start|work)|dead|stopped working/i,
  noise: /nois|rattl|buzz|grind/i,
  temperature: /not (?:heat|cool)|no (?:heat|cool)|warm|cold|freez/i,
  damage: /crack|broken|damage|stuck|won.t (?:open|close)/i,
};
const ROOMS = [
  "kitchen",
  "bathroom",
  "bedroom",
  "living room",
  "basement",
  "garage",
];
const tokens = (s) =>
  new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(
        (t) =>
          t.length > 2 &&
          ![
            "the",
            "and",
            "request",
            "issue",
            "problem",
            "maintenance",
            "with",
            "there",
            "this",
            "that",
            "have",
            "has",
          ].includes(t),
      ),
  );
const overlap = (a, b) => {
  const x = tokens(a),
    y = tokens(b);
  return x.size && y.size
    ? [...x].filter((t) => y.has(t)).length / new Set([...x, ...y]).size
    : 0;
};
function facts(row = {}) {
  const text = [
    row.issueTitle,
    row.issueDescription,
    row.shortTitle,
    row.summary,
    row.subcategory,
    row.ai?.summary,
    row.ai?.shortTitle,
    row.ai?.subcategory,
    row.location?.room,
    row.ai?.location?.room,
  ]
    .filter(Boolean)
    .join(" ");
  const matches = (rules) =>
    Object.entries(rules)
      .filter(([, r]) => r.test(text))
      .map(([id]) => id);
  const room = String(
    row.location?.room || row.ai?.location?.room || "",
  ).toLowerCase();
  return {
    text,
    assets: matches(ASSETS),
    symptoms: matches(SYMPTOMS),
    rooms: ROOMS.filter(
      (r) => room.includes(r) || text.toLowerCase().includes(r),
    ),
  };
}
function rankSimilar(incoming, rows) {
  const a = facts(incoming);
  return rows
    .flatMap((row) => {
      const b = facts(row);
      const asset = a.assets.find((x) => b.assets.includes(x));
      const symptom = a.symptoms.find((x) => b.symptoms.includes(x));
      if (!asset || !symptom) return [];
      if (
        a.rooms.length &&
        b.rooms.length &&
        !a.rooms.some((x) => b.rooms.includes(x))
      )
        return [];
      // Explicitly different known fixtures do not become duplicates via a generic
      // title such as "not working". Asset and symptom matches are mandatory.
      const room = a.rooms.find((x) => b.rooms.includes(x));
      const score =
        0.4 +
        0.35 +
        (room ? 0.15 : 0) +
        0.1 *
          overlap(
            incoming.shortTitle || incoming.issueTitle,
            row.ai?.shortTitle || row.issueTitle,
          );
      return [
        {
          id: String(row._id),
          issueTitle: row.ai?.shortTitle || row.issueTitle,
          createdAt: row.createdAt,
          reason: `Same ${room ? `${room} ` : ""}${asset} and ${symptom === "power" ? "power problem" : symptom === "drainage" ? "drainage problem" : symptom + " problem"}`,
          score,
        },
      ];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.createdAt) - new Date(a.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 3)
    .map(({ score, ...row }) => row);
}
async function findSimilar({ tenant, incoming }) {
  const unitId = tenant?.unit?._id || tenant?.unit;
  if (!unitId || !tenant?._id) return [];
  const rows = await Request.find({
    tenantId: tenant._id,
    landlordId: tenant.landlord,
    unitId,
    status: { $in: OPEN },
    archivedAt: null,
  })
    .select(
      "_id issueTitle issueDescription ai.shortTitle ai.summary ai.subcategory ai.location createdAt",
    )
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return rankSimilar(incoming, rows);
}
module.exports = { rankSimilar, findSimilar, facts };
