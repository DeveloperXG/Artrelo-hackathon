const express = require("express");
const Sentry = require("@sentry/node");
const morgan = require("morgan");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const env = require("./config/env");
const { resolveClientIp } = require("./middleware/clientIp.middleware");

const authRoutes = require("./routes/auth.routes");
const codeRoutes = require("./routes/code.routes");
const tenantRoutes = require("./routes/tenant.routes");
const landlordRoutes = require("./routes/landlord.routes");
const profileRoutes = require("./routes/profile.routes");
const requestRoutes = require("./routes/request.routes");
const aiRoutes = require("./routes/ai.routes");
const paymentRoutes = require("./routes/payment.routes");
const tenantNotificationRoutes = require("./routes/tenantNotification.routes");
const uploadRoutes = require("./routes/upload.routes");
const vendorPortalRoutes = require("./routes/vendorPortal.routes");
const vendorHubRoutes = require("./routes/vendorHub.routes");
const publicContactRoutes = require("./routes/publicContact.routes");

const { userAuth } = require("./middleware/auth.middleware");
const { authorize } = require("./middleware/authorization.middleware");

const app = express();

// Dev runs the SPA and the marketing site as separate servers on ports that
// move around (3000/3001 by npm script, 3100/3101 under .claude/launch.json),
// so any loopback origin is accepted locally. Production is pinned to an exact
// allow-list — it serves both from one origin via the reverse proxy, so the
// marketing entry is only needed if marketing is deployed to its own host.
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

let allowedOrigins = null; // null = dev, accept any loopback origin

if (env.is_production) {
  if (!env.frontend_url) {
    throw new Error(
      "FRONTEND_URL is required when IS_PRODUCTION is on — it pins CORS to the app origin. " +
        "Set it (scheme + host, no trailing slash) and restart."
    );
  }
  allowedOrigins = [env.frontend_url, env.marketing_url]
    .filter(Boolean)
    .map((url) => url.replace(/\/$/, ""));

  // Behind nginx/Railway the socket IP is the proxy's, so every visitor would
  // share one rate-limit bucket. Trust exactly one hop — `true` would let a
  // client spoof X-Forwarded-For and walk straight past the per-IP limiter.
  app.set("trust proxy", 1);

  // One hop is not always what Railway delivers, so req.ip is then taken from
  // Railway's X-Real-IP instead. Mounted here, first, and only in production:
  // the header is trustworthy behind Railway's edge and nowhere else. See the
  // middleware for the details.
  app.use(resolveClientIp);
}

const corsOptions = {
  // Same-origin and non-browser callers send no Origin header; those are not
  // CORS requests and must not be rejected here.
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const ok = allowedOrigins ? allowedOrigins.includes(origin) : LOOPBACK_ORIGIN.test(origin);
    // Disallowed origins get `false`, not an Error: the response simply omits
    // the ACAO header and the browser blocks it. Throwing would turn every
    // probe into a logged 500.
    return callback(null, ok);
  },
  credentials: true,
};

app.use(helmet());
app.use(cors(corsOptions));
morgan.token("safe-url", req => String(req.originalUrl || req.url).split("?")[0]
  .replace(/(\/vendor-portal\/|\/booking\/vendor\/|\/vendor-hub\/session\/)[^/]+/g, "$1[token]"));
app.use(morgan(":method :safe-url :status :response-time ms"));
// MOUNTED BEFORE express.json ON PURPOSE. Stripe signature verification hashes
// the exact bytes it sent, so the handler needs the RAW body. Parsed as JSON
// first, the computed signature never matches and every legitimate event 400s.
app.post(
  "/api/v1/webhooks/stripe",
  express.raw({ type: "application/json" }),
  require("./controllers/stripeWebhook.controller").handleStripeWebhook
);
// SAME REASON, DIFFERENT CONTENT TYPE. Twilio signs an HMAC over the exact
// request it sent, so this also needs the RAW body — but Twilio posts
// form-encoded, not JSON, so express.raw is scoped to that type. Mounted for
// "application/x-www-form-urlencoded" and NOT for JSON: reusing the Stripe
// line's type would let the global express.urlencoded below parse it first,
// leaving req.body an object and 403-ing every real message.
//
// Mounted only while the relay is switched on (RELAY_SMS_ENABLED). Deferred
// feature, dormant rail: with the flag off there is no session to route to, so
// the endpoint would only answer strangers. Flipping the flag mounts it again
// -- no code change, as the relay handoff requires.
if (env.relay_sms_enabled) {
  app.post(
    "/api/v1/webhooks/twilio/sms",
    express.raw({ type: "application/x-www-form-urlencoded" }),
    require("./controllers/twilioWebhook.controller").handleTwilioInboundSms
  );
}

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const API_PREFIX = "/api/v1";

// Public
app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/codes`, codeRoutes);
app.use(`${API_PREFIX}/ai`, aiRoutes);
// Vendor magic-link portal — token-authorized, no session. Same origin as the
// SPA that serves the form, so the CORS pin above is not a constraint here.
app.use(`${API_PREFIX}/vendor-portal`, vendorPortalRoutes);

// Vendor hub. Cookie-authorized via hubAuth, which sets req.vendorIdentity and
// never req.user — so a hub session cannot satisfy authorize() on any landlord
// or tenant route even if one were mounted carelessly.
app.use(`${API_PREFIX}/vendor-hub`, vendorHubRoutes);
app.use(`${API_PREFIX}/booking`, require("./routes/bookingCoordination.routes"));

// Marketing-site contact form. Fully public and rate-limited in the router —
// the marketing app is a static export and has no server to post to.
app.use(`${API_PREFIX}/public/contact`, publicContactRoutes);

// Evidence uploads (any authenticated user; auth enforced per-route)
app.use(`${API_PREFIX}/uploads`, uploadRoutes);

// Tenant scope
app.use(
  `${API_PREFIX}/tenants`,
  userAuth,
  authorize(["tenant", "primary_tenant", "co-tenant"]),
  tenantRoutes
);

// Landlord scope
app.use(`${API_PREFIX}/landlords`, landlordRoutes);
// Disabled by default. Only the isolated judge bootstrap injects a verified
// pair-scoped service; an environment flag alone cannot activate simulation.
app.use(`${API_PREFIX}/judge-sandbox`, require('./routes/judgeSandbox.routes').createJudgeSandboxRouter());
app.use(`${API_PREFIX}/iris`, require('./routes/iris.routes').createRuntimeIrisRouter());

// Shared profile (any authenticated user)
app.use(`${API_PREFIX}/profile`, profileRoutes);

// Direct request access (used by detail view for both tenant & landlord)
app.use(`${API_PREFIX}/requests`, requestRoutes);

// Notifications (tenant)
app.use(`${API_PREFIX}/notifications`, userAuth, tenantNotificationRoutes);
// "Send feedback" from inside the app (landlords and tenants).
app.use(`${API_PREFIX}/feedback`, userAuth, require("./routes/feedback.routes"));

// Live nudges (SSE) for any signed-in landlord or tenant. Carries topics only;
// see services/realtime/liveEvents.service.js.
app.get(`${API_PREFIX}/live`, userAuth, require("./services/realtime/liveEvents.service").handleLiveStream);

// Payments (stub)
app.use(`${API_PREFIX}/payments`, paymentRoutes);

// Health
app.get("/api", (req, res) => res.json({ success: true, message: "Artrelo API up", env: env.node_env }));
app.get(`${API_PREFIX}/health`, (req, res) =>
  res.json({ success: true, status: "ok", time: new Date().toISOString() })
);

// 404 fallback for /api routes
app.use("/api", (req, res) =>
  res.status(404).json({ success: false, message: `API endpoint not found: ${req.originalUrl}` })
);

// Report unhandled route errors to Sentry with the route that failed, then let
// the handler below answer. A no-op without SENTRY_DSN.
Sentry.setupExpressErrorHandler(app);

// Centralized error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[error]", err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

module.exports = app;

