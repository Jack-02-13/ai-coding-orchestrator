import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createBridgeServer } from '../src/server.mjs';

function makeFakeApp() {
  const calls = [];
  return {
    calls,
    state: { clientId: null, hostId: null },
    credentials: null,
    authAttempt: null,
    sseClients: new Set(),
    snapshot: () => ({ auth: { connected: false, planUsageEnabled: false }, messages: [], tasks: [] }),
    broadcast() {},
    async persistNow() {},
    async control(...args) { calls.push(['control', ...args]); },
    async addRequirement(value) { calls.push(['requirement', value.text]); return { ok: true }; },
    async refreshModels() { throw Object.assign(new Error('Bearer synthetic-access-token-secret user@example.invalid'), { detail: 'refresh_token=synthetic-refresh-token-secret' }); },
  };
}

function request(port, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: data }));
    });
    req.on('upgrade', (response, socket) => {
      resolve({ status: response.statusCode, headers: response.headers, body: '' });
      socket.destroy();
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startTestServer(t) {
  const app = makeFakeApp();
  const server = createBridgeServer({ app, port: 0 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { app, server, port, origin: `http://127.0.0.1:${port}` };
}

test('local dashboard and API work only on the exact loopback host and origin', async (t) => {
  const { app, port, origin } = await startTestServer(t);
  const page = await request(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);

  const state = await request(port, '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.equal(state.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(state.headers['access-control-allow-origin'], undefined);

  const crossOriginState = await request(port, '/api/state', { headers: { origin: 'https://attacker.invalid' } });
  assert.equal(crossOriginState.status, 403);
  const crossSiteSse = await request(port, '/api/events', { headers: { origin: 'https://attacker.invalid' } });
  assert.equal(crossSiteSse.status, 403);
  const crossSiteFetchMetadata = await request(port, '/api/state', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSiteFetchMetadata.status, 403);
  const reboundHost = await request(port, '/api/state', { headers: { host: `attacker.invalid:${port}` } });
  assert.equal(reboundHost.status, 403);

  const crossOriginPost = await request(port, '/api/control', {
    method: 'POST', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop' }),
  });
  assert.equal(crossOriginPost.status, 403);
  const missingOriginPost = await request(port, '/api/control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop' }),
  });
  assert.equal(missingOriginPost.status, 403);

  const localPost = await request(port, '/api/control', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }),
  });
  assert.equal(localPost.status, 200);
  for (const action of ['resume', 'stop']) {
    const response = await request(port, '/api/control', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action }),
    });
    assert.equal(response.status, 200);
  }
  const requirement = await request(port, '/api/requirements', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'synthetic live requirement' }),
  });
  assert.equal(requirement.status, 202);
  assert.deepEqual(app.calls, [['control', 'pause', ''], ['control', 'resume', ''], ['control', 'stop', ''], ['requirement', 'synthetic live requirement']]);
});

test('path traversal cannot read source files through the static server', async (t) => {
  const { port } = await startTestServer(t);
  const response = await request(port, '/%2e%2e/src/helpers.mjs');
  assert.equal(response.status, 404);
  assert.equal(response.body.includes('REQUIRED_PLAN_SCOPE'), false);
});

test('WebSocket upgrades are explicitly rejected; the dashboard uses same-origin SSE', async (t) => {
  const { port } = await startTestServer(t);
  const response = await request(port, '/api/socket', {
    headers: {
      origin: 'https://attacker.invalid',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  });
  assert.equal(response.status, 403);
});

test('forged OAuth callbacks do not cancel a pending login or reflect callback secrets', async (t) => {
  const { app, port } = await startTestServer(t);
  app.authAttempt = { state: 'expected-state' };
  const response = await request(port, '/auth/callback?state=wrong-state&code=synthetic-one-time-code', {
    headers: { origin: 'https://auth.openai.com', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/');
  assert.equal(response.body.includes('synthetic-one-time-code'), false);
  assert.equal(app.authAttempt.state, 'expected-state');

  const legitimateBrowserCallback = await request(port, '/auth/callback?state=expected-state', {
    headers: { origin: 'https://auth.openai.com', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(legitimateBrowserCallback.status, 303);
  assert.equal(app.authAttempt, null);
  assert.match(app.state.authMessage, /expected authorization code/);
});

test('API failures redact OAuth credentials and personal data before returning responses', async (t) => {
  const { port, origin } = await startTestServer(t);
  const response = await request(port, '/api/models/refresh', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.includes('synthetic-access-token-secret'), false);
  assert.equal(response.body.includes('synthetic-refresh-token-secret'), false);
  assert.equal(response.body.includes('user@example.invalid'), false);
});
