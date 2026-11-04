const express = require('express');
const { verifyAccessToken } = require('../services/auth/tokens.service');
const { contract, error } = require('../services/iris/contract.service');
const { assertValid } = require('../contracts/validate.cjs');
const { authorize } = require('../services/iris/auth.service');
const { loadKnowledge } = require('../services/iris/knowledge.service');
const { createReadContext } = require('../services/iris/readContext.service');
const { createPolicyChanges } = require('../services/iris/policyChange.service');
const { createConversations } = require('../services/iris/conversation.service');
function createIrisRouter({ service, changes, knowledge = loadKnowledge(), authenticateToken = verifyAccessToken } = {}) {
  const router = express.Router();
  if (!changes) changes = createPolicyChanges();
  if (!service) service = createConversations({ authorize, reads: createReadContext({ knowledge }), changes,
    Turns: require('../models/IrisTurn'), Access: require('../models/IrisToolAccess'), knowledge });
  function failure(res, err) {
    const code = Object.hasOwn(contract.errors, err.code) ? err.code : err.status === 400 ? 'invalid_input' : 'service_unavailable';
    if (err.retryAfterSeconds !== undefined && err.retryAfterSeconds !== null) res.set('Retry-After', String(err.retryAfterSeconds));
    return res.status(contract.errors[code]).json({ success: false, message: code === 'service_unavailable' ? 'Iris is unavailable. Try again later.' : err.message.slice(0, 800), code,
      retryAfterSeconds: err.retryAfterSeconds ?? null, currentPolicyRevision: err.currentPolicyRevision ?? null, field: err.field ?? null });
  }
  // Same signed access token/type/algorithm as the rest of the application.
  // Local wrapper only standardizes this frozen API's closed error envelope.
  router.use(async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (typeof header !== 'string' || !/^Bearer \S+$/i.test(header)) throw error('auth_expired', 'Sign in again to continue.');
      let decoded;try { decoded = authenticateToken(header.slice(7)); } catch { throw error('auth_expired', 'Sign in again to continue.'); }
      req.irisUser = { id: decoded.userId, role: decoded.role, accountId: decoded.accountId, expiresAt: decoded.exp ? decoded.exp * 1000 : null };
      await service.authenticate(req.irisUser);next();
    } catch (err) { failure(res, err); }
  });
  for (const endpoint of contract.endpoints) {
    router[endpoint.method.toLowerCase()](endpoint.path, async (req, res) => {
      try {
        let input = req.body;
        if (endpoint.method === 'GET' && endpoint.input) {
          if (Object.keys(req.query).some(k => !['cursor', 'limit'].includes(k)) || (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') || (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)))) throw error('invalid_input', 'Invalid impact page.');
          input = { cursor: req.query.cursor ?? null, limit: req.query.limit === undefined ? 50 : Number(req.query.limit) };
        }
        if (endpoint.input) {
          if (Buffer.byteLength(JSON.stringify(input ?? null)) > 8192) throw error('invalid_input', 'This Iris message is too large.');
          try { assertValid(endpoint.input, input, contract.$defs); } catch { throw error('invalid_input', 'Check the Iris action and try again.'); }
        }
        const user = req.irisUser, ref = req.params.id;
        let data;
        switch (endpoint.path) {
          case '/conversations': data = await service.create(user, input);break;
          case '/conversations/:id/context': data = await service.context(user, ref, input);break;
          case '/conversations/:id/close': data = await service.close(user, ref, input);break;
          case '/conversations/:id/turns': data = await service.accept(user, ref, input);break;
          case '/turns/:id': data = await service.getTurn(user, ref);break;
          case '/turns/:id/cancel': data = await service.cancel(user, ref);break;
          case '/evidence/:ref': data = await service.evidence(user, req.params.ref);break;
          default: {
            const auth = await service.authenticate(user);
            if (endpoint.path.endsWith('/confirm')) {
              const row = await changes.owned(auth, ref);
              const release = row.state === 'preview_ready' ? service.reserveConfirm(auth, row.origin, ref) : null;
              try {
                service.rate(auth, 'confirm', 10, 900000);data = await changes.confirm(auth, ref, input);
              } finally { await release?.(); }
            }
            else if (endpoint.path.endsWith('/discard')) data = await changes.discard(auth, ref);
            else if (endpoint.path.endsWith('/impact')) { service.rate(auth, 'reads', 100, 60000);data = await changes.impactPage(auth, ref, input); }
            else { service.rate(auth, 'reads', 100, 60000);data = await changes.view(auth, ref); }
          }
        }
        assertValid(endpoint.output, data, contract.$defs);
        res.status(endpoint.status).json({ success: true, data });
      } catch (err) { failure(res, err); }
    });
  }
  return router;
}
// Normal application entry remains off. The explicitly guarded isolated
// bootstrap supplies its runtime router before loading app.js.
module.exports = { createIrisRouter, createLandlordIrisRouter: () => createIrisRouter(), createRuntimeIrisRouter: () => express.Router() };
