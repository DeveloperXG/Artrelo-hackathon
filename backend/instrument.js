// Error monitoring (Sentry). Required FIRST in server.js, before Express or
// Mongoose load, so the SDK can instrument them.
//
// Off unless SENTRY_DSN is set: local dev, the test stack and the unit/e2e
// runs report nothing.
//
// WHY console.error IS CAPTURED. Most failures here are deliberately
// non-fatal: a payout that fails, a webhook handler that throws, a sweeper pass
// that errors, an email that bounces -- each is logged with console.error and
// the request carries on, because a money or notification side effect must
// never undo a finished job. That is right for the user and invisible to us.
// Capturing console.error turns every one of those into an alert without
// touching the call sites. Sentry's default dedupe drops the second copy when
// an error is both thrown and logged.
//
// PRIVACY. Requests carry tenants' messages, passwords and payment ids, so no
// request bodies, cookies, headers or IPs are sent (sendDefaultPii off, and
// beforeSend strips what remains). Errors only: no performance tracing.

const Sentry = require("@sentry/node");
const env = require("./config/env");

// Vendor job links, magic sign-in links and reset links carry their secret in
// the path (32 random bytes, 43 characters). Any segment that long is redacted;
// ordinary ids (24 characters) are left alone. Query strings and fragments go.
const LONG_SEGMENT = /\/[A-Za-z0-9_-]{32,}(?=\/|$)/g;
function scrubUrl(url) {
  if (typeof url !== "string") return url;
  return url.split(/[?#]/)[0].replace(LONG_SEGMENT, "/[redacted]");
}

// What console.error was called with, reduced to what is safe to keep. The
// console integration attaches the raw arguments as extra data, and an error
// object can carry the request it failed on -- body-parser's carries the whole
// body. Text survives (token-scrubbed); an error keeps its name and message;
// any other object is dropped.
function summarizeArguments(args, scrubText) {
  return args.map((arg) => {
    if (typeof arg === "string") return scrubText(arg);
    if (arg && typeof arg === "object" && (arg.message || arg.name)) {
      return scrubText(`${arg.name || "Error"}: ${arg.message || ""}`);
    }
    if (arg === null || ["number", "boolean", "undefined"].includes(typeof arg)) return arg;
    return "[object omitted]";
  });
}

function scrubRequest(event, hint) {
  // A client's mistake (a 4xx: malformed JSON, a bad id) is answered and logged,
  // but it is not our bug, and its message can quote what the client sent.
  const original = hint?.originalException;
  const status = Number(original?.status ?? original?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) return null;

  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    event.request.url = scrubUrl(event.request.url);
  }
  // A logged message can carry a link too ("[sendVendorOutreach] ... /vendor-response/<token>").
  const scrubText = (text) => (typeof text === "string" ? text.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]") : text);
  // Breadcrumbs include recent console output with its raw arguments (in stub
  // mode, magic sign-in links are console.log'd). Keep the line, scrubbed;
  // drop the arguments.
  for (const crumb of event.breadcrumbs || []) {
    if (crumb.message) crumb.message = scrubText(crumb.message);
    if (crumb.data) {
      delete crumb.data.arguments;
      if (crumb.data.url) crumb.data.url = scrubUrl(crumb.data.url);
    }
  }
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  if (event.message) event.message = scrubText(event.message);
  for (const ex of event.exception?.values || []) ex.value = scrubText(ex.value);
  // Extra data is dropped wholesale, except a reduced copy of console.error's
  // arguments: nothing in it is needed to fix a bug that the stack and message
  // don't already say, and it is where request bodies were leaking.
  const args = Array.isArray(event.extra?.arguments) ? event.extra.arguments : null;
  event.extra = args ? { arguments: summarizeArguments(args, scrubText) } : undefined;
  if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  return event;
}

if (env.sentry_dsn) {
  Sentry.init({
    dsn: env.sentry_dsn,
    environment: env.sentry_environment || env.node_env || "development",
    // Railway sets this per deploy, so an alert names the commit that broke.
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    integrations: [Sentry.captureConsoleIntegration({ levels: ["error"] })],
    beforeSend: scrubRequest,
  });
}

module.exports = { Sentry, scrubRequest, scrubUrl };
