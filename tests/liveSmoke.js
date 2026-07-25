const assert = require('node:assert/strict');

const baseUrl = process.env.LIVE_BASE_URL || 'https://huzaifa1435-carpool.hf.space';

async function readJson(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { res, json };
}

(async () => {
  const root = await fetch(`${baseUrl}/?logs=container`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(root.status, 200, 'root should not return 404');
  const rootJson = await root.json();
  assert.equal(rootJson.success, true);
  assert.equal(rootJson.status, 'running');

  const api = await readJson('/api');
  assert.equal(api.res.status, 200, '/api should return service metadata');
  assert.equal(api.json.success, true);

  const health = await readJson('/health');
  assert.equal(health.res.status, 200, '/health should be OK');
  assert.deepEqual(health.json, { status: 'ok' });

  const protectedRoutes = [
    '/api/auth/profile',
    '/api/rides',
    '/api/rides/my-rides',
    '/api/customer-requests',
    '/api/customer-requests/my',
    '/api/deals/my-bookings',
    '/api/wallet',
  ];

  for (const route of protectedRoutes) {
    const result = await readJson(route);
    assert.equal(result.res.status, 401, `${route} should require auth`);
    assert.match(result.json?.error || '', /token/i, `${route} should return auth JSON`);
  }

  console.log(`Live smoke tests passed for ${baseUrl}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
