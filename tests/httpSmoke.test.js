const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const app = require('../src/app');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function get(path, headers = {}) {
  return fetch(`${baseUrl}${path}`, { headers });
}

describe('CarPool backend smoke tests', () => {
  it('serves the root backend status page without 404', async () => {
    const res = await get('/');
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.match(body, /CarPool Backend is running/);
  });

  it('serves root JSON status for API clients and query-string probes', async () => {
    const res = await get('/?logs=container', { accept: 'application/json' });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.status, 'running');
    assert.equal(json.apiBase, '/api');
  });

  it('serves API metadata and health checks', async () => {
    const apiRes = await get('/api');
    const apiJson = await apiRes.json();
    const healthRes = await get('/health');
    const healthJson = await healthRes.json();
    const apiHealthRes = await get('/api/health');
    const apiHealthJson = await apiHealthRes.json();

    assert.equal(apiRes.status, 200);
    assert.equal(apiJson.endpoints.rides.includes('/api/rides/my-rides'), true);
    assert.equal(healthRes.status, 200);
    assert.deepEqual(healthJson, { status: 'ok' });
    assert.equal(apiHealthRes.status, 200);
    assert.deepEqual(apiHealthJson, { status: 'ok' });
  });

  it('returns clean auth errors for protected routes instead of crashing', async () => {
    const routes = [
      '/api/auth/profile',
      '/api/rides',
      '/api/rides/my-rides',
      '/api/customer-requests',
      '/api/customer-requests/my',
      '/api/deals/my-bookings',
      '/api/wallet',
      '/api/notifications',
    ];

    for (const route of routes) {
      const res = await get(route);
      const json = await res.json();

      assert.equal(res.status, 401, route);
      assert.match(json.error || '', /token/i, route);
    }
  });

  it('returns structured JSON for unknown routes', async () => {
    const res = await get('/api/not-a-real-route');
    const json = await res.json();

    assert.equal(res.status, 404);
    assert.equal(json.success, false);
    assert.equal(json.code, 'ROUTE_NOT_FOUND');
  });
});
