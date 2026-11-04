// Real booking router + real rate limiters in isolated ephemeral HTTP servers.
// Controller/auth stubs scope this to limiter binding and ordering; this is not
// ownership/permission proof. No app data, runtime counters, model or providers.
const assert = require('node:assert/strict'), http = require('node:http'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const backend = path.resolve(__dirname, '../../..');
const scenario = process.argv[2];
if (!scenario) {
  let failed = false;
  for (const name of ['mutation-first', 'preview-first']) {
    const result = spawnSync(process.execPath, [__filename, name], { encoding: 'utf8', timeout: 15000 });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    if (result.status !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
} else {
  const express = require(path.join(backend, 'node_modules/express'));
  let calls = 0;
  const authPath = require.resolve(path.join(backend, 'middleware/auth.middleware'));
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
    userAuth(req, res, next) { if (req.headers.authorization !== 'Bearer synthetic-http-user') return res.status(401).json({ success: false });
      req.user = { id: 'synthetic-user', role: 'landlord' }; next(); },
  } };
  const controllerPath = require.resolve(path.join(backend, 'controllers/bookingCoordination.controller'));
  const handler = (_req, res) => { calls++; return res.json({ success: true }); };
  require.cache[controllerPath] = { id: controllerPath, filename: controllerPath, loaded: true,
    exports: Object.fromEntries(['getCoordination', 'respond', 'retryNotice', 'getVendorCoordination', 'respondVendor', 'interpretAvailability', 'returnToVendor'].map(name => [name, handler])) };
  const app = express(); app.use(express.json()); app.use('/booking', require(path.join(backend, 'routes/bookingCoordination.routes')));
  async function main() {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const request = (url, auth = true) => new Promise((resolve, reject) => {
      const body = JSON.stringify({ text: 'tomorrow 2pm to 4pm', timeZone: 'America/Regina' });
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: url,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(auth ? { Authorization: 'Bearer synthetic-http-user' } : {}) } }, response => {
        response.resume(); response.once('end', () => resolve({ status: response.statusCode, headers: response.headers }));
      }); req.once('error', reject); req.end(body);
    });
    const preview = index => request(index % 2 ? '/booking/vendor/synthetic-purpose-token/availability' : '/booking/requests/synthetic-request/availability');
    const mutation = () => request('/booking/vendor/synthetic-purpose-token');
    try {
      assert.equal((await request('/booking/requests/synthetic-request/availability', false)).status, 401, 'authenticated gate before preview counter');
      assert.equal(calls, 0);
      if (scenario === 'mutation-first') {
        for (let index = 0; index < 10; index++) assert.equal((await mutation()).status, 200, `mutation ${index + 1} allowed`);
        const denied = await mutation(); assert.equal(denied.status, 429, 'existing mutation guard stays10/15min');
        assert(Number(denied.headers['retry-after']) > 0, 'actual retry header');
        for (let index = 0; index < 30; index++) assert.equal((await preview(index)).status, 200, `preview ${index + 1} remains independent of exhausted mutation quota`);
        assert.equal((await preview(30)).status, 429, 'preview allowance remains bounded');
      } else if (scenario === 'preview-first') {
        for (let index = 0; index < 30; index++) assert.equal((await preview(index)).status, 200, `preview ${index + 1} allowed`);
        assert.equal((await preview(30)).status, 429, 'preview quota exhausted');
        for (let index = 0; index < 10; index++) assert.equal((await mutation()).status, 200, `mutation ${index + 1} remains independent of exhausted preview quota`);
        assert.equal((await mutation()).status, 429, 'mutation allowance unchanged');
      } else throw new Error('Unknown isolated scenario');
      assert.equal(calls, 40, 'only accepted routes reach controller');
      console.log(JSON.stringify({ status: 'PASS', scenario, actualRouter: true, previewLimit: 30, mutationLimit: 10, windowMinutes: 15,
        runtimeCountersTouched: false, liveCalls: 0, testSpendUSD: 0, recordingSpendUSD: 0 }));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  main().catch(error => { console.error(JSON.stringify({ status: 'FAIL', scenario, failure: error.message })); process.exitCode = 1; });
}
