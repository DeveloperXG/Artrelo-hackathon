// Synthetic only; shared unchanged across both provider adapters.
module.exports = [
  { message: "The kitchen sink has been leaking under the cabinet for two hours. The sink is unusable. I already tightened the fitting and it still leaks. Weekday evenings work. You cannot enter when I am away.", category: "Plumbing", room: "kitchen", consent: false },
  { message: "The bathroom fan is not working since yesterday. I haven't tried anything. No pets. Weekend mornings work.", category: "Electrical", room: "bathroom", consent: null },
  { message: "Actually it is the bathroom, not the kitchen. It is still unusable.", category: "Plumbing", room: "bathroom", consent: null,
    context: { previousTriage: { location: { room: "kitchen", area: "" }, impact: "sink unusable" }, conversationHistory: [{ role: "user", content: "The kitchen sink is unusable." }] } },
  { message: "There is active flooding from a burst pipe. You cannot enter when I am away.", category: "Plumbing", emergency: true, consent: false },
  { message: "I don't know", category: "Other", context: { conversationHistory: [{ role: "assistant", content: "When did you first notice it?" }] }, answeredTopic: "timeline", answerState: "unknown" },
  { message: "I prefer not to answer", category: "Other", context: { conversationHistory: [{ role: "assistant", content: "Where exactly is this happening?" }] }, answeredTopic: "location", answerState: "declined" },
];
