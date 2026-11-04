// Synthetic tenant reports; shared by deterministic provider mocks and live replays.
module.exports = [
  {
    category: "Plumbing",
    message: "The kitchen sink pipe has leaked since Monday. I tightened the fitting without success and put a bucket underneath; the water is contained. I cannot use the sink. Weekdays 9 to 5 work, but I can arrange an earlier visit if needed.",
    facts: { subcategory: "Leaking pipe", impact: "Kitchen sink unusable", location: { room: "Kitchen", area: "Under sink" }, timeline: { started: "Monday", trend: "Stable" }, attemptedFixes: ["Tightened fitting without success", "Bucket contains water"], access: { preferredTimes: ["Weekdays 9 to 5"] }, additionalNotes: "Water contained in a bucket. Can arrange an earlier visit if needed." },
    notes: /bucket.*earlier/i,
  },
  {
    category: "Electrical",
    message: "The bedroom outlets have had no power since yesterday. The breaker keeps tripping after I reset it twice. I cannot use the bedroom outlets. This could be a fire hazard, but there is no smoke, burning smell or sparks. Afternoons work for me.",
    facts: { subcategory: "Repeated breaker trip", impact: "Bedroom outlets unusable", location: { room: "Bedroom", area: "Outlets" }, timeline: { started: "yesterday", trend: "Stable" }, attemptedFixes: ["Reset breaker twice; keeps tripping"], access: { preferredTimes: ["Afternoons"] }, additionalNotes: "Tenant concerned about a possible fire hazard; no smoke, burning smell or sparks. Repeated breaker reset unsuccessful." },
    notes: /possible fire hazard.*breaker/i,
  },
  {
    category: "HVAC",
    message: "The heating has not worked since Tuesday. The thermostat is set to heat at 22 degrees, but indoors it is 17 degrees. The living room feels chilly. I checked the thermostat, changed the air filter and checked that the breaker is on. Evenings are best.",
    facts: { subcategory: "No heat", impact: "Living room chilly", location: { room: "Living room", area: "Heating" }, timeline: { started: "Tuesday", trend: "Stable" }, attemptedFixes: ["Checked thermostat at 22 degrees", "Changed air filter", "Checked breaker is on"], access: { preferredTimes: ["Evenings"] }, additionalNotes: "Thermostat on heat at 22 degrees; reported indoor temperature 17 degrees.", topicAnswers: [{ topicId: "thermostat", state: "answered" }, { topicId: "indoorTemperature", state: "answered" }, { topicId: "filter", state: "answered" }, { topicId: "breaker", state: "answered" }] },
    notes: /22.*17/i,
  },
  {
    category: "Structural",
    message: "Since last week the living room wall cracks are widening and the door has shifted and sticks. It is difficult to close. I haven't tried fixing it and cannot measure the cracks precisely. Weekend visits work.",
    facts: { subcategory: "Widening wall cracks", impact: "Door difficult to close", location: { room: "Living room", area: "Wall and doorway" }, timeline: { started: "last week", trend: "Worsening" }, attemptedFixes: [], access: { preferredTimes: ["Weekends"] }, additionalNotes: "Widening cracks and door movement reported; no repairs attempted; cannot provide exact measurements.", topicAnswers: [{ topicId: "structuralChange", state: "answered" }, { topicId: "attemptedFixes", state: "answered" }] },
    notes: /door movement.*measurements/i,
  },
  {
    category: "Pest",
    message: "For three nights I have seen mice in the kitchen, droppings behind the fridge and scratching noises in the wall. I am uncomfortable using the kitchen. I cleaned up and set traps, but they are still here. Any day, anytime works for a visit.",
    facts: { subcategory: "Mice", impact: "Uncomfortable using kitchen", location: { room: "Kitchen", area: "Behind fridge and wall" }, timeline: { started: "three nights ago", trend: "Stable" }, attemptedFixes: ["Cleaned up", "Set traps without success"], access: { preferredTimes: ["Any day, anytime"] }, additionalNotes: "Mice sighted, droppings behind fridge, scratching in wall; traps unsuccessful. Unrestricted visit availability.", topicAnswers: [{ topicId: "pestEvidence", state: "answered" }] },
    notes: /droppings.*scratching.*unrestricted/i,
  },
];
