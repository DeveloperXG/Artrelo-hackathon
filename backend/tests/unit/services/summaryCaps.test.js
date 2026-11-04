// Summary length and sentence integrity.
//
// The old pipeline had three disagreeing caps — 240 on the model summary at the
// TOP of normalizeTriageOutput, 300 inside synthesizeSummary, 480 on notes —
// applied at different points. A cumulative recap (issue, room, when it started,
// the trend, the impact, what was already tried) does not fit in 240 characters,
// so it was cut mid-sentence and then frozen that way by applySummaryLock.
//
// There were NO length assertions anywhere before this file, which is how the
// caps drifted apart in the first place.

const assert = require("assert");

const {
  normalizeTriageOutput,
  deterministicTriage,
  capAtSentenceBoundary,
  synthesizeSummary,
  SUMMARY_MAX_CHARS,
} = require("../../../services/ai/categorization.service");

const endsCleanly = (text) => /[.!?]["')\]]?$/.test(String(text).trim());

/* ------------------------------------------------------------------ *
 * capAtSentenceBoundary
 * ------------------------------------------------------------------ */

function testCapAtSentenceBoundary() {
  const prose =
    "Leaking pipe in the kitchen. It started two hours ago. Water is pooling on the floor. " +
    "The tenant shut off the under-sink valve.";

  // Under budget: untouched.
  assert.strictEqual(capAtSentenceBoundary(prose, 500), prose);

  // Over budget: whole sentences only, never a dangling clause.
  const cut = capAtSentenceBoundary(prose, 60);
  assert.ok(cut.length <= 60);
  assert.ok(endsCleanly(cut), `must end on sentence punctuation, got: "${cut}"`);
  assert.strictEqual(cut, "Leaking pipe in the kitchen. It started two hours ago.");

  // The one case with no whole sentence to keep. A bare word-boundary cut reads
  // exactly like the model stopping early — the bug this all started from — so
  // the fallback must MARK itself as shortened.
  const monster = `${"word ".repeat(40)}end.`;
  const fallback = capAtSentenceBoundary(monster, 50);
  assert.ok(fallback.length <= 50, "the ellipsis must fit inside the budget");
  assert.ok(!fallback.endsWith("wor"), "must not cut mid-word");
  assert.ok(fallback.endsWith("…"), "an unavoidable mid-sentence cut is marked, not silent");

  // Whitespace is normalized.
  assert.strictEqual(capAtSentenceBoundary("  a   b  ", 100), "a b");
}

/* ------------------------------------------------------------------ *
 * A cumulative recap survives whole — the actual reported bug.
 * ------------------------------------------------------------------ */

function testCumulativeSummarySurvives() {
  const cumulative =
    "Leaking supply line under the kitchen sink, in the cabinet beneath the basin. " +
    "The tenant first noticed it about two hours ago and reports it is getting steadily worse. " +
    "The kitchen sink is unusable and water has begun pooling on the floor and swelling the cabinet base. " +
    "The tenant has already tightened the compression nut, placed a bucket underneath to catch the drip, " +
    "and shut off the under-sink shut-off valve. Access is available on weekdays after 4pm, and there is " +
    "a cat in the unit that must not be allowed out through the front door.";

  assert.ok(cumulative.length > 240, "fixture must exceed the OLD cap to be meaningful");

  const triage = normalizeTriageOutput(
    { summary: cumulative, category: "Plumbing", urgency: "high" },
    "my sink is leaking",
    "Plumbing"
  );

  assert.strictEqual(
    triage.summary,
    cumulative,
    "a full cumulative recap must survive intact — this is the reported truncation bug"
  );
  assert.ok(endsCleanly(triage.summary));
}

/* ------------------------------------------------------------------ *
 * One budget, applied once.
 * ------------------------------------------------------------------ */

function testSingleBudget() {
  const runaway = "The tenant reports a problem in the unit. ".repeat(80);
  assert.ok(runaway.length > SUMMARY_MAX_CHARS, "fixture must exceed the cap");

  const triage = normalizeTriageOutput(
    { summary: runaway, category: "Other", urgency: "medium" },
    "something is wrong",
    "Other"
  );

  assert.ok(triage.summary.length <= SUMMARY_MAX_CHARS, "the backstop still applies");
  assert.ok(endsCleanly(triage.summary), "even the backstop cut ends on a sentence");
}

/* ------------------------------------------------------------------ *
 * synthesizeSummary no longer carries its own smaller, conflicting cap.
 * ------------------------------------------------------------------ */

function testSynthesizeHasNoOwnCap() {
  const synthesized = synthesizeSummary({
    category: "Plumbing",
    subcategory: "Leaking supply line",
    location: { room: "kitchen", area: "under the sink" },
    timeline: { started: "two hours ago", trend: "Worsening" },
    impact: "Kitchen sink unusable and water pooling on the floor",
    // Enough fixes to blow past the old 300-char slice.
    attemptedFixes: [
      "tightened the compression nut",
      "placed a bucket underneath to catch the drip",
      "shut off the under-sink shut-off valve",
      "mopped the cabinet base and laid towels",
      "moved everything out of the cabinet",
    ],
  });

  assert.ok(synthesized.length > 300, "must no longer be clipped at 300");
  assert.ok(endsCleanly(synthesized), "the synthesized recap ends cleanly");
  assert.ok(!synthesized.includes("undefined"));
}

/* ------------------------------------------------------------------ *
 * The deterministic fallback path uses the same budget.
 * ------------------------------------------------------------------ */

function testDeterministicPath() {
  const long =
    "There is a leak under my kitchen sink and it started about two hours ago. " +
    "It is getting worse and there is water on the floor now. " +
    "I already tried tightening the nut and put a bucket under it. " +
    "I also turned off the little valve under the sink.";

  assert.ok(long.length > 240, "fixture must exceed the OLD cap");

  const triage = deterministicTriage({ message: long });

  assert.strictEqual(triage.summary, long, "the fallback keeps the tenant's full description");
  assert.match(triage.summary, /getting worse.*water on the floor/);
  assert.match(triage.summary, /turned off the little valve/);
  assert.strictEqual(triage.location.room, "kitchen", "preserve extracted facts alongside the narrative");
  assert.ok(triage.timeline.started.includes("two hours"));
  assert.ok(triage.attemptedFixes.some((fix) => fix.includes("tightening the nut")));
  for (const topicId of ["location", "timeline", "attemptedFixes"]) {
    assert.notStrictEqual(triage.intakeState.selectedQuestion?.topicId, topicId,
      "preserving the narrative must not re-ask established facts");
  }
  assert.ok(endsCleanly(triage.summary));
  assert.ok(triage.shortTitle.length <= 60, "the title is still a compact heading");
}

function testFallbackHazardContainmentCapAndLock() {
  const message = "The bathroom outlet started sparking two minutes ago. " +
    "The outlet is unusable and the wall is getting hot. " +
    "I already turned off the breaker and kept everyone away from the bathroom.";
  const triage = deterministicTriage({ message });
  assert.strictEqual(triage.summary, message, "retain hazard and containment narrative, not just extracted fields");
  assert.strictEqual(triage.urgency, "emergency");
  assert.strictEqual(triage.readyToSubmit, true);
  assert.strictEqual(triage.location.room, "bathroom");
  assert.ok(triage.attemptedFixes.some((fix) => fix.includes("turned off the breaker")));
  assert.deepStrictEqual(triage.followUpQuestions, []);

  const update = "Please call before arriving. The breaker remains off.";
  const locked = deterministicTriage({ message: update, context: { previousTriage: triage } });
  assert.strictEqual(locked.summary, message, "the ready-to-submit narrative stays locked verbatim");
  assert.ok(locked.additionalNotes.includes(update), "retain the new detail in the addendum");
  assert.strictEqual(locked.location.room, "bathroom");

  const overBudget = message + " The tenant added another operational detail about the affected room.".repeat(30);
  const capped = deterministicTriage({ message: overBudget });
  assert.strictEqual(capped.summary, capAtSentenceBoundary(overBudget, SUMMARY_MAX_CHARS));
  assert.ok(capped.summary.length <= SUMMARY_MAX_CHARS);
  assert.ok(endsCleanly(capped.summary));
  assert.ok(capped.summary.startsWith(message), "the existing cap retains the leading hazard and containment details");
}

/* ------------------------------------------------------------------ *
 * Notes are capped on a sentence boundary too, not hard-sliced.
 * ------------------------------------------------------------------ */

function testNotesCap() {
  const notes = "The tenant added a further detail about the access arrangements. ".repeat(30);
  const triage = normalizeTriageOutput(
    { summary: "A leak.", additionalNotes: notes, category: "Plumbing", urgency: "low" },
    "leak",
    "Plumbing"
  );
  assert.ok(triage.additionalNotes.length > 0);
  assert.ok(endsCleanly(triage.additionalNotes), "notes must not be hard-sliced mid-word");
}

testCapAtSentenceBoundary();
testCumulativeSummarySurvives();
testSingleBudget();
testSynthesizeHasNoOwnCap();
testDeterministicPath();
testFallbackHazardContainmentCapAndLock();
testNotesCap();
console.log("summary cap tests passed");
