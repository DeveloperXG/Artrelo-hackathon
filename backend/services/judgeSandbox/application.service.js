const { error, id, MESSAGES } = require('./contract.service');
function deniedFinancialMutation(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  const path = req.path;
  return /^\/payments(?:\/|$)/.test(path) || /^\/landlords\/(?:ledger|billing)(?:\/|$)/.test(path) || /^\/landlords\/appointments\/[^/]+\/direct-payment(?:\/|$)/.test(path);
}
async function createSandboxApplication({ proof, connection = require('mongoose').connection, liveProviders = null } = {}) {
  const guard = require('./offlineGuard.service');
  const live = guard.isGuardedLiveProof(proof) && require('./liveProviders.service').isLiveProviders(liveProviders, proof);
  const offline = guard.isOfflineGuardProof(proof) && proof.mode === 'offline_judge_core' && liveProviders === null;
  if ((!offline && !live) || proof.database !== connection.name || connection !== require('mongoose').connection) throw error('sandbox_disabled');
  require('./fixture.service').syntheticDatabase(connection);
  const config = require('../../config/env');
  if (['meta_api_key', 'openai_api_key', 'resend_api_key', 'stripe_secret_key', 'twilio_auth_token', 'sentry_dsn'].some(k => config[k]) ||
    config.outreach_email_enabled || config.emergency_calls_enabled || config.relay_sms_enabled || config.service_billing_collection_enabled || config.is_production) throw error('sandbox_disabled');
  const seed = await require('../../models/JudgeSandboxSeed').findById('judge-core-v1').lean();if (seed?.state !== 'ready') throw error('sandbox_disabled');
  const authorize = require('./auth.service').createPairAuthorizer(), bindings = require('./bindings.service').createBindings({ connection, authorize });
  const domain = require('./domain.service').createDomain({ bindings });
  const notifications = require('./notifications.service').createNotificationBridge({ proof, authorize, domain });
  const service = require('./run.service').createRuns({ enabled: true, authorize, store: require('./store.service').createStore({ connection }), ...domain });
  const routes = require('../../routes/judgeSandbox.routes'), factory = routes.createJudgeSandboxRouter;
  const irisRoutes = require('../../routes/iris.routes'), irisFactory = irisRoutes.createRuntimeIrisRouter;
  const landlordIrisFactory = irisRoutes.createLandlordIrisRouter;
  if (require.cache[require.resolve('../../app')]) throw error('sandbox_disabled');
  if (live) liveProviders.register();
  let app;
  routes.createJudgeSandboxRouter = options => factory({ ...options, service });
  // The frontend uses the landlord mount. Both guarded aliases must share one
  // conversation service; constructing the default router silently uses fallback.
  let irisRouter;
  const scopedIrisRouter = () => irisRouter ||= live ? liveProviders.createIrisRouter() : irisRoutes.createIrisRouter();
  irisRoutes.createRuntimeIrisRouter = scopedIrisRouter;
  irisRoutes.createLandlordIrisRouter = scopedIrisRouter;
  try { app = require('../../app'); } finally {
    routes.createJudgeSandboxRouter = factory;irisRoutes.createRuntimeIrisRouter = irisFactory;
    irisRoutes.createLandlordIrisRouter = landlordIrisFactory;
  }
  const outer = require('express')();
  outer.get('/health', (req, res) => res.json({ ready: true, syntheticOnly: true, mode: proof.mode,
    ...(live ? { providerAttempts: proof.diagnostics().modelAttempts } : { realModelCalls: 0 }), realDelivery: false, realPayment: false }));
  const authPaths = new Set(['/auth/landlord/login', '/auth/tenant/login', '/auth/logout', '/auth/refresh-token']);
  outer.use('/api/v1', async (req, res, next) => {
    try {
      if (req.method === 'OPTIONS') return next();
      if (req.method === 'POST' && authPaths.has(req.path)) return next();
      if (req.path.startsWith('/auth/') || deniedFinancialMutation(req) || /^\/(?:vendor-portal|vendor-hub|public|uploads)(?:\/|$)/.test(req.path)) throw error('forbidden_role');
      if (typeof req.headers.authorization !== 'string' || !/^Bearer \S+$/i.test(req.headers.authorization)) throw error('auth_expired');
      let decoded;try { decoded = require('../auth/tokens.service').verifyAccessToken(req.headers.authorization.slice(7)); } catch { throw error('auth_expired'); }
      const ctx = await authorize({ id: decoded.userId, role: decoded.role, accountId: decoded.accountId });
      // AsyncLocalStorage propagates to the ordinary tenant submission's
      // background initial-routing task; no request/consent is fabricated.
      return await (live ? liveProviders.withUser({ id: decoded.userId, role: decoded.role, accountId: decoded.accountId,
        expiresAt: Number.isFinite(decoded.exp) ? decoded.exp * 1000 : null }, () => bindings.withPair(ctx, () => next())) : bindings.withPair(ctx, () => next()));
    } catch (e) {
      const code = Object.hasOwn(require('../../contracts/judgeSandbox.v1.json').errors, e.code) ? e.code : 'service_unavailable';
      return res.status(require('../../contracts/judgeSandbox.v1.json').errors[code]).json({ success: false, code, message: MESSAGES[code] });
    }
  });
  outer.use(app);
  return { app: outer, service, bindings, domain, notifications, diagnostics: proof.diagnostics };
}
module.exports = { createSandboxApplication, deniedFinancialMutation };
