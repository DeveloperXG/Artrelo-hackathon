const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

// Required here, but only CALLED inside the exported object below, which is
// evaluated after dotenv has populated process.env.
const { envFlag } = require("./flags");

const nodeEnv = process.env.NODE_ENV || "dev";
const envBaseDir = path.resolve(__dirname, "..");
const envCandidates = [
  `.env.${nodeEnv}.local`,
  `.env.${nodeEnv}`,
  ".env.local",
  ".env",
];

envCandidates.forEach((fileName) => {
  const fullPath = path.resolve(envBaseDir, fileName);
  if (fs.existsSync(fullPath)) {
    dotenv.config({ path: fullPath, override: false });
  }
});

module.exports = {
  port: process.env.PORT || 8001,
  node_env: nodeEnv,
  booking_confirmations_paused: envFlag("BOOKING_CONFIRMATIONS_PAUSED"),
  // Applies only to newly issued outreach. Legacy links/jobs are not backfilled.
  quote_itemization_enabled: envFlag("QUOTE_ITEMIZATION_ENABLED"),
  quote_analysis_mode: process.env.QUOTE_ANALYSIS_MODE || "disabled",
  mongodb_uri: process.env.MONGODB_URI,
  session_secret: process.env.SESSION_SECRET,

  jwt_secret: process.env.JWT_SECRET,
  jwt_expires_in: process.env.JWT_EXPIRES_IN || "15m",
  refresh_token_secret: process.env.REFRESH_TOKEN_SECRET,
  refresh_token_expires_in: process.env.REFRESH_TOKEN_EXPIRES_IN || "7d",
  sys_api_key: process.env.SYSTEM_API_KEY,

  // AI
  openai_api_key: process.env.OPENAI_API_KEY,
  openai_model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  openai_base_url: process.env.OPENAI_BASE_URL,
  ai_triage_provider: process.env.AI_TRIAGE_PROVIDER || "openai",
  ai_triage_fallback_provider: process.env.AI_TRIAGE_FALLBACK_PROVIDER || "none",
  meta_api_key: process.env.MODEL_API_KEY,
  meta_model: process.env.META_MODEL || "muse-spark-1.3",
  ai_triage_timeout_ms: process.env.AI_TRIAGE_TIMEOUT_MS || "10000",
  ai_triage_max_tokens: process.env.AI_TRIAGE_MAX_TOKENS || "2500",

  // Email (Resend)
  resend_api_key: process.env.RESEND_API_KEY,
  resend_from_email: process.env.RESEND_FROM_EMAIL,

  // Display name external recipients see beside the address. `??` not `||` so
  // setting it empty is an explicit "send the bare address" rather than
  // silently falling back to the default.
  resend_from_name: process.env.RESEND_FROM_NAME ?? "Artrelo",

  // Destination for marketing-site contact inquiries. A real mailbox/alias
  // (Zoho), not a Resend identity — Resend only sends, it never receives.
  sales_email: process.env.SALES_EMAIL || "sales@artrelo.com",

  // Default Reply-To for every outbound email. RESEND_FROM_EMAIL is a
  // no-reply identity, so without this a vendor or tenant who hits reply is
  // writing to nobody. Must be a monitored mailbox.
  support_email: process.env.SUPPORT_EMAIL || "support@artrelo.com",

  // Cloudinary
  cloudinary_cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  cloudinary_api_key: process.env.CLOUDINARY_API_KEY,
  cloudinary_api_secret: process.env.CLOUDINARY_API_SECRET,

  // Frontend
  frontend_url: process.env.FRONTEND_URL,

  // Marketing site origin. Behind the reference proxy the marketing export and
  // the API share one host, so CORS never comes into play; this exists for the
  // dev split (marketing :3001) and for deploying marketing separately.
  marketing_url: process.env.MARKETING_URL,

  // Public base URL used to build vendor magic links. FRONTEND_URL is only
  // required in production (see app.js), so dev falls back to the Vite port.
  app_public_url:
    process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || "http://localhost:3000",

  // Timezone used to label vendor availability windows. Slots are stored as
  // ISO UTC; this only affects the human-readable labels in the email/form.
  outreach_timezone: process.env.OUTREACH_TIMEZONE || "America/Regina",

  // How long a completed or cancelled request stays in the working lists
  // before the archive sweeper moves it to the property/unit history.
  // Overridable so the sweep can be exercised without waiting a week.
  archive_after_days: (() => {
    const days = Number(process.env.ARCHIVE_AFTER_DAYS);
    return Number.isFinite(days) && days >= 0 ? days : 7;
  })(),

  // How long a new landlord's free beta runs when the inviter does not say
  // (invite_landlord.js --beta-days). Validated in config/beta.js, which falls
  // back to 60 on a missing or nonsense value.
  beta_default_days: process.env.BETA_DEFAULT_DAYS,
  // Artrelo's service fee on a completed job, at LIST price: a flat amount plus
  // an optional percentage of the job's payout (services/ledger/serviceFee.js).
  // Raw strings, validated by the consumer. Both default to 0, and while every
  // fee setting is 0 no fee is charged or shown anywhere.
  // What Stripe charges Artrelo to pay vendors through Connect, used only by the
  // revenue report's cost ESTIMATE (services/metrics/revenueReport.service.js).
  // Defaults are Stripe's published CAD rates ($2 per vendor per month with a
  // payout, 0.25% + $0.25 per bank payout); correct them from the first live
  // payout's Fees tab. Never affect what a landlord is charged.
  connect_account_fee_cents: process.env.CONNECT_ACCOUNT_FEE_CENTS,
  connect_payout_fee_percent: process.env.CONNECT_PAYOUT_FEE_PERCENT,
  connect_payout_fee_fixed_cents: process.env.CONNECT_PAYOUT_FEE_FIXED_CENTS,
  service_fee_cents: process.env.SERVICE_FEE_CENTS,
  service_fee_percent: process.env.SERVICE_FEE_PERCENT,
  // Independent switches: assessment/booking cutover and live collection.
  service_billing_enabled: envFlag("SERVICE_BILLING_ENABLED"),
  service_billing_collection_enabled: envFlag("SERVICE_BILLING_COLLECTION_ENABLED"),
  billing_tax_reviewed: envFlag("BILLING_TAX_REVIEWED"),
  billing_automatic_tax: envFlag("BILLING_AUTOMATIC_TAX"),
  billing_tax_code: process.env.BILLING_TAX_CODE,
  stripe_billing_payment_method_configuration_id: process.env.STRIPE_BILLING_PAYMENT_METHOD_CONFIGURATION_ID,
  // The founding offer's numbers (see config/beta.js). Raw strings, validated by
  // the consumer like card_fee_percent. All default to 0 = "no rate chosen yet".
  service_fee_founding_cents: process.env.SERVICE_FEE_FOUNDING_CENTS,
  service_fee_founding_percent: process.env.SERVICE_FEE_FOUNDING_PERCENT,
  founding_plan_discount_percent: process.env.FOUNDING_PLAN_DISCOUNT_PERCENT,

  // Kill switch for outbound vendor email. When false the outreach record is
  // still created (so the flow stays testable) but nothing is sent.
  outreach_email_enabled: envFlag("OUTREACH_EMAIL_ENABLED", true),

  // Landlord self-serve sign-up. While false, /auth/landlord/sign-up rejects
  // requests (see registration.middleware.js), mirroring the frontends'
  // REGISTRATION_ENABLED flag. Set the env var to a true value to reopen.
  registration_enabled: envFlag("REGISTRATION_ENABLED"),

  // Tenant sign-up, which is a different question from landlord sign-up and so
  // a different switch. A tenant cannot arrive unannounced: they need an invite
  // code, and a code only exists because a landlord with an account generated
  // one. So during a closed beta this can be open while landlord sign-up is
  // shut — otherwise a beta landlord has a dashboard with no tenants to file
  // anything into it, which is the whole product.
  //
  // It stays OFF unless set, because opening it exposes the code-guessing
  // surface: /codes/verify answers "is this a real code" to anyone. That is
  // why codes are long and both endpoints are rate limited.
  tenant_signup_enabled: envFlag("TENANT_SIGNUP_ENABLED"),

  // Production posture: an exact CORS allow-list, `trust proxy 1` and the
  // X-Real-IP middleware (see app.js). A BOOLEAN — it used to be the raw
  // string, compared against "TRUE" at the call site, so IS_PRODUCTION=true
  // read as false and silently dropped the proxy handling, putting every
  // visitor in one rate-limit bucket.
  is_production: envFlag("IS_PRODUCTION"),

  // Stripe. The secret key was declared twice in this object; the duplicate
  // above was removed (the later one had been silently winning).
  stripe_secret_key: process.env.STRIPE_SECRET_KEY,
  stripe_pub_key: process.env.STRIPE_PUB_KEY,
  // Required before the webhook processes ANY event. Without it the endpoint
  // returns 503 rather than accepting unverified payloads — an endpoint that
  // trusts whatever it is sent is worse than one that is switched off.
  stripe_webhook_secret: process.env.STRIPE_WEBHOOK_SECRET,
  // The THIN (v2) event destination's secret. In a deployed account the
  // snapshot and thin destinations are separate and each has its own whsec_,
  // so one variable cannot verify both. Unset falls back to the snapshot
  // secret, which is what `stripe listen` wants: it signs everything it
  // forwards with one CLI secret.
  stripe_webhook_secret_thin: process.env.STRIPE_WEBHOOK_SECRET_THIN,
  // Card processing fee added on top of a wallet top-up (services/ledger/
  // cardFees.js). Unset means Stripe's domestic Canadian rate, 2.9% + 30¢.
  // Expiring, single-intent $1 live pilot. Normal card minimum remains $20.
  card_pilot_landlord_id: process.env.CARD_PILOT_LANDLORD_ID,
  card_pilot_starts_at: process.env.CARD_PILOT_STARTS_AT,
  card_pilot_expires_at: process.env.CARD_PILOT_EXPIRES_AT,
  card_fee_percent: process.env.CARD_FEE_PERCENT,
  card_fee_fixed_cents: process.env.CARD_FEE_FIXED_CENTS,
  // Canadian pre-authorized debit (Stripe acss_debit) as a wallet top-up.
  // OFF by default: while off, top-ups are card-only exactly as before. The
  // numeric settings are parsed (with safe defaults) in
  // services/ledger/bankDebitSettings.js, never read raw.
  bank_debit_enabled: envFlag("BANK_DEBIT_ENABLED"),
  bank_topup_min_cents: process.env.BANK_TOPUP_MIN_CENTS,
  bank_topup_new_cap_cents: process.env.BANK_TOPUP_NEW_CAP_CENTS,
  bank_trusted_after: process.env.BANK_TRUSTED_AFTER,
  bank_failure_fee_cents: process.env.BANK_FAILURE_FEE_CENTS,
  bank_dispute_fee_cents: process.env.BANK_DISPUTE_FEE_CENTS,
  bank_verification_fee_cents: process.env.BANK_VERIFICATION_FEE_CENTS,
  bank_mandate_transaction_type: process.env.BANK_MANDATE_TRANSACTION_TYPE,

  // Twilio (masked vendor <-> tenant SMS relay).
  twilio_account_sid: process.env.TWILIO_ACCOUNT_SID,
  twilio_auth_token: process.env.TWILIO_AUTH_TOKEN,

  // The pool of proxy numbers, comma-separated E.164. NOT a single number:
  // inbound routing resolves on (From, To) alone, so one vendor holding two
  // live jobs needs two numbers or their reply is unroutable. See the header of
  // models/ProxySession.js. Pool size is therefore the cap on concurrent jobs
  // per vendor, not on total jobs.
  twilio_proxy_numbers: String(process.env.TWILIO_PROXY_NUMBERS || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean),

  // The EXACT public URL Twilio posts to. Twilio's signature is computed over
  // the full URL, and behind a proxy or tunnel req.protocol/req.host report the
  // internal one, so a reconstructed URL fails to verify for reasons that look
  // like a bad token. Pin it here; the handler falls back to reconstruction and
  // says so in the log.
  twilio_webhook_url: process.env.TWILIO_WEBHOOK_URL,

  // Master switch for outbound relay SMS, defaulting to OFF.
  //
  // Deliberately opt-in rather than credential-detected (which is how email
  // decides). A2P 10DLC brand + campaign registration is a CARRIER approval,
  // not a technical one: sending unregistered application-to-person traffic
  // gets the sending brand filtered and fined, and having credentials in the
  // env is not evidence the paperwork cleared. So adding a key to test
  // something else must not start real traffic — the operator says so
  // explicitly, once, after registration completes.
  relay_sms_enabled: envFlag("RELAY_SMS_ENABLED"),

  // Error monitoring (instrument.js). Unset = off, which is what local dev and
  // the test runs want. SENTRY_ENVIRONMENT names the deploy ("production",
  // "staging"); it falls back to NODE_ENV.
  sentry_dsn: process.env.SENTRY_DSN,
  sentry_environment: process.env.SENTRY_ENVIRONMENT,

  // EMERGENCY CALLS to the landlord (services/notification/emergencyCall.service).
  // A voice call, not a text: calls are not A2P messaging, so they need no
  // 10DLC registration -- a Twilio number with voice is enough. Off unless the
  // switch is set, for the same reason as the relay: a stray credential must
  // not start phoning people. Uses the TWILIO_ACCOUNT_SID / AUTH_TOKEN above.
  emergency_calls_enabled: envFlag("EMERGENCY_CALLS_ENABLED"),
  // E.164 Twilio number the call comes from, e.g. +13065550100.
  twilio_voice_from: process.env.TWILIO_VOICE_FROM,

};

// Legacy compat exports
const cfg = module.exports;
Object.assign(module.exports, cfg);
