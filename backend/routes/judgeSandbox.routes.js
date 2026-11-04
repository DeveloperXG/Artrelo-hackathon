const express = require('express');
const { verifyAccessToken } = require('../services/auth/tokens.service');
const { createRuns } = require('../services/judgeSandbox/run.service');
const { contract, validate, error, MESSAGES } = require('../services/judgeSandbox/contract.service');
function createJudgeSandboxRouter({ service = createRuns(), authenticateToken = verifyAccessToken } = {}) {
  const router = express.Router();
  function failure(res, err) {
    const code = Object.hasOwn(contract.errors, err.code) ? err.code : 'service_unavailable';
    const data = { success: false, code, message: MESSAGES[code], retryAfterSeconds: Number.isInteger(err.retryAfterSeconds) && err.retryAfterSeconds >= 0 ? err.retryAfterSeconds : null, nextAvailableAt: null };
    if (data.retryAfterSeconds !== null) res.set('Retry-After', String(data.retryAfterSeconds));
    return res.status(contract.errors[code]).json(validate('Error', data));
  }
  router.use((req, res, next) => {
    try {
      if (typeof req.headers.authorization !== 'string' || !/^Bearer \S+$/i.test(req.headers.authorization)) throw error('auth_expired');
      let decoded;try { decoded = authenticateToken(req.headers.authorization.slice(7)); } catch { throw error('auth_expired'); }
      req.judgeUser = { id: decoded.userId, role: decoded.role, accountId: decoded.accountId };next();
    } catch (e) { failure(res, e); }
  });
  const rates = new Map();
  function rate(user, kind, maximum) {
    const at = Date.now(), key = user.id + ':' + kind;
    if (rates.size > 200) for (const [k, r] of rates) if (r.every(t => at - t >= 900000)) rates.delete(k);
    const row = (rates.get(key) || []).filter(t => at - t < 900000);
    if (row.length >= maximum) throw Object.assign(error('rate_limited'), { retryAfterSeconds: Math.max(1, Math.ceil((row[0] + 900000 - at) / 1000)) });
    row.push(at);rates.set(key, row);
  }
  for (const endpoint of contract.endpoints) router[endpoint.method.toLowerCase()](endpoint.path, async (req, res) => {
    try {
      if (Object.keys(req.query).length) throw error('invalid_input');
      let result;
      if (endpoint.method === 'GET') {
        rate(req.judgeUser, 'read', 600);
        result = { data: await service.status(req.judgeUser), httpStatus: 200 };
      } else {
        if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > contract.limits.actionBodyBytes) throw error('invalid_input');
        validate(endpoint.input, req.body);rate(req.judgeUser, 'write', 60);
        result = endpoint.path === '/runs' ? await service.start(req.judgeUser, req.body, req.headers['idempotency-key'])
          : await service.action(req.judgeUser, req.params.id, endpoint.path.split('/').at(-1), req.body, req.headers['idempotency-key']);
      }
      if (result.httpStatus >= 400) return failure(res, error(result.data?.error?.code || 'service_unavailable'));
      validate(endpoint.output, result.data);res.status(result.httpStatus).json({ success: true, data: result.data });
    } catch (e) { failure(res, e); }
  });
  return router;
}
module.exports = { createJudgeSandboxRouter };
