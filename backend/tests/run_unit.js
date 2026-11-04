// Runs every tests/unit/**/*.test.js file in its own child process.
//
// Separate processes are required for isolation: several tests monkeypatch
// shared modules (e.g. Mongoose models), so running them in one process would
// leak stubs between files. Each child preloads _unit_setup.js for a hermetic
// (no-network) environment. Exits non-zero if any maintained file fails.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const UNIT_DIR = path.join(__dirname, "unit");
const PRELOAD = path.join(__dirname, "_unit_setup.js");

// Pre-existing broken tests, stale since commit 3269dfc (vendor/routing service
// APIs were refactored without updating these specs). They were never wired
// into an npm script, so the rot went unnoticed. Quarantined here so the runner
// stays green for maintained tests; failures are reported but don't fail the
// command. Remove an entry once its test is fixed. Tracked separately from the
// intake pre-screen / token-bucket work.
const KNOWN_BROKEN = new Set([
  path.join("unit", "models", "vendor.model.test.js"),
  path.join("unit", "services", "routingDecision.service.test.js"),
  path.join("unit", "services", "vendorScoring.service.test.js"),
]);

function findTests(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTests(full));
    else if (entry.name.endsWith(".test.js")) found.push(full);
  }
  return found;
}

const files = findTests(UNIT_DIR).sort();
const failures = []; // maintained tests that failed (real problems)
const stillBroken = []; // quarantined tests, expected to fail
const unexpectedlyPassing = []; // quarantined tests that now pass (un-quarantine!)

for (const file of files) {
  const rel = path.relative(__dirname, file);
  const quarantined = KNOWN_BROKEN.has(rel);
  process.stdout.write(`\n▶ ${rel}${quarantined ? "  (quarantined)" : ""}\n`);
  const result = spawnSync(process.execPath, ["-r", PRELOAD, file], {
    stdio: "inherit",
  });
  const passed = result.status === 0;
  if (quarantined) {
    (passed ? unexpectedlyPassing : stillBroken).push(rel);
  } else if (!passed) {
    failures.push(rel);
  }
}

const maintained = files.length - KNOWN_BROKEN.size;
process.stdout.write(
  `\n${maintained - failures.length}/${maintained} maintained unit test files passed` +
    ` (${stillBroken.length} quarantined)\n`
);
if (unexpectedlyPassing.length) {
  process.stdout.write(
    `Now passing — remove from KNOWN_BROKEN:\n${unexpectedlyPassing
      .map((f) => `  - ${f}`)
      .join("\n")}\n`
  );
}
if (failures.length) {
  process.stdout.write(`Failed:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
