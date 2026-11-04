# artrelo.com: the marketing static export and the SPA, built separately and
# served together by Caddy with a path split (deploy/Caddyfile.railway).
#
# Built by the Railway "web" service from the repo root, configured by
# deploy/railway.web.json (set as that service's config path). The API
# is a separate service built from backend/ and is not part of this image.
#
# BUILD-TIME CONFIG. Everything below is baked into static files, so it is a
# build argument, not a runtime variable — changing one on Railway needs a
# REBUILD, not a restart. None of these are secrets. Each is set once and fed
# to both apps under the names each one reads, so the two cannot drift:
#
#   SITE_URL               canonical/OG/sitemap base            (marketing)
#   API_ORIGIN             e.g. https://api.artrelo.com         (both)
#   STRIPE_PUBLISHABLE     pk_live_/pk_test_ publishable key    (SPA wallet)
#   REGISTRATION_ENABLED   public landlord sign-up   "true"/unset
#   TENANT_SIGNUP_ENABLED  invite-code sign-up       "true"/unset
#   SIGN_IN_ENABLED        /login                    "true"/unset
#   SENTRY_DSN             SPA error reporting; unset = off. Not a secret: a
#                          browser DSN is visible to every visitor anyway.
#
# The values reach each build as inline environment on its RUN line rather
# than through ENV, so nothing is written into an image layer, and the Stripe
# argument is deliberately not named *KEY — both keep Docker's
# SecretsUsedInArgOrEnv lint quiet without silencing it for the whole file.

# glibc, not alpine: both lockfiles pin the -gnu native builds of Tailwind's
# oxide engine, lightningcss, rollup and Next's SWC, and sharp has no musl
# entry. With those present, `npm ci` installs exactly what is locked.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- Marketing: Next.js static export -> /src/marketing/out ----------------
FROM ${NODE_IMAGE} AS marketing
WORKDIR /src/marketing
ENV NEXT_TELEMETRY_DISABLED=1
COPY marketing/package.json marketing/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY marketing/ ./
ARG SITE_URL=https://artrelo.com
ARG API_ORIGIN=https://api.artrelo.com
ARG REGISTRATION_ENABLED
ARG TENANT_SIGNUP_ENABLED
ARG SIGN_IN_ENABLED
RUN NEXT_PUBLIC_SITE_URL="$SITE_URL" \
    NEXT_PUBLIC_API_URL="$API_ORIGIN" \
    NEXT_PUBLIC_REGISTRATION_ENABLED="$REGISTRATION_ENABLED" \
    NEXT_PUBLIC_TENANT_SIGNUP_ENABLED="$TENANT_SIGNUP_ENABLED" \
    NEXT_PUBLIC_SIGN_IN_ENABLED="$SIGN_IN_ENABLED" \
    npm run build

# ---- SPA: Vite build -> /src/frontend/dist ---------------------------------
FROM ${NODE_IMAGE} AS spa
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
ARG API_ORIGIN=https://api.artrelo.com
ARG STRIPE_PUBLISHABLE
ARG REGISTRATION_ENABLED
ARG TENANT_SIGNUP_ENABLED
ARG SIGN_IN_ENABLED
ARG SENTRY_DSN
RUN VITE_API_URL="$API_ORIGIN/api/v1" \
    VITE_STRIPE_PUBLISHABLE_KEY="$STRIPE_PUBLISHABLE" \
    VITE_REGISTRATION_ENABLED="$REGISTRATION_ENABLED" \
    VITE_TENANT_SIGNUP_ENABLED="$TENANT_SIGNUP_ENABLED" \
    VITE_SIGN_IN_ENABLED="$SIGN_IN_ENABLED" \
    VITE_SENTRY_DSN="$SENTRY_DSN" \
    VITE_SENTRY_ENVIRONMENT=production \
    npm run build

# ---- Serve ------------------------------------------------------------------
FROM caddy:2-alpine
COPY deploy/Caddyfile.railway /etc/caddy/Caddyfile
COPY --from=marketing /src/marketing/out /srv/marketing
COPY --from=spa /src/frontend/dist /srv/app
# Fail the BUILD, not the deploy, on a bad Caddyfile — and prove the two
# outputs landed where the Caddyfile expects them.
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
 && test -f /srv/marketing/index.html \
 && test -f /srv/marketing/404.html \
 && test -f /srv/app/index.html
