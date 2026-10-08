import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator.mjs';
import { exchangeCode, makeAuthorizationAttempt, validateTokenResponse } from './oauth.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, '..', 'public');
const port = Number(process.env.AI_DEV_PORT ?? 1455);
const app = new Orchestrator();

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  }
  try { return body ? JSON.parse(body) : {}; }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}

function sameOrigin(request) {
  const host = request.headers.host;
  if (!['127.0.0.1:1455', `127.0.0.1:${port}`].includes(host)) return false;
  const origin = request.headers.origin;
  return !origin || origin === `http://${host}`;
}

async function serveStatic(urlPath, response) {
  const table = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/transcript.js': ['transcript.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/transcript-ui.css': ['transcript-ui.css', 'text/css; charset=utf-8'],
  };
  const file = table[urlPath];
  if (!file) return false;
  try {
    const content = await readFile(path.join(publicDir, file[0]));
    response.writeHead(200, {
      'content-type': file[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'referrer-policy': 'no-referrer',
    });
    response.end(content);
    return true;
  } catch { return false; }
}

async function authCallback(url, response) {
  const attempt = app.authAttempt;
  const returnHtml = (status, title, message) => {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
    response.end(`<!doctype html><meta charset="utf-8"><title>${htmlEscape(title)}</title><main style="font:16px system-ui;max-width:42rem;margin:8vh auto;padding:2rem"><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p><p>You can close this tab and return to AI Developer Bridge.</p></main>`);
  };
  if (!attempt) return returnHtml(400, 'Sign-in was not started', 'Return to the dashboard and start a new ChatGPT sign-in.');
  if (url.searchParams.get('state') !== attempt.state) {
    app.authAttempt = null;
    app.state.authMessage = 'OAuth state validation failed. Start sign-in again.';
    app.broadcast();
    return returnHtml(400, 'Sign-in could not be validated', app.state.authMessage);
  }
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    app.authAttempt = null;
    app.state.authMessage = oauthError === 'access_denied'
      ? 'ChatGPT plan use was not authorized. No model request was sent.'
      : `OpenAI sign-in stopped with ${oauthError}.`;
    app.state.lastError = { kind: 'auth', message: app.state.authMessage };
    await app.persistNow();
    app.broadcast();
    return returnHtml(403, 'ChatGPT sign-in not completed', app.state.authMessage);
  }
  const code = url.searchParams.get('code');
  const issuedClientId = url.searchParams.get('client_id') || (attempt.firstTime ? '' : app.credentials?.client_id ?? app.state.clientId ?? '');
  if (!code || !issuedClientId || (!attempt.firstTime && url.searchParams.has('client_id') && url.searchParams.get('client_id') !== (app.credentials?.client_id ?? app.state.clientId))) {
    app.authAttempt = null;
    app.state.authMessage = 'The callback did not contain the expected authorization code or issued client ID. No credentials were changed.';
    app.state.lastError = { kind: 'auth', message: app.state.authMessage };
    await app.persistNow();
    app.broadcast();
    return returnHtml(400, 'ChatGPT sign-in incomplete', app.state.authMessage);
  }
  app.state.clientId = issuedClientId;
  await app.persistNow();
  try {
    const token = await exchangeCode({ code, clientId: issuedClientId, verifier: attempt.verifier, redirectUri: attempt.redirectUri });
    const credential = await validateTokenResponse(token, {
      clientId: issuedClientId, nonce: attempt.nonce, previousSubject: attempt.firstTime ? null : app.credentials?.subject,
      hostId: attempt.hostId,
    });
    app.credentials = credential;
    await app.vault.write('credentials.dpapi.json', credential);
    app.authAttempt = null;
    app.state.authMessage = `Connected to ChatGPT${credential.email ? ` as ${credential.email}` : ''}; ChatGPT plan usage scope verified.`;
    app.state.lastError = null;
    app.state.planBlocked = false;
    await app.persistNow();
    app.broadcast();
    return returnHtml(200, 'ChatGPT connected', 'OAuth signature, issuer, audience, nonce, account identity, and ChatGPT plan usage permission were verified.');
  } catch (error) {
    app.authAttempt = null;
    app.state.authMessage = error.message;
    app.state.lastError = { kind: 'auth', message: error.message };
    await app.persistNow();
    app.broadcast();
    return returnHtml(403, 'ChatGPT plan usage unavailable', error.message);
  }
}

async function route(request, response) {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (request.method === 'GET' && url.pathname === '/auth/callback') return authCallback(url, response);
  if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, app.snapshot());
  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    response.write(`event: state\ndata: ${JSON.stringify(app.snapshot())}\n\n`);
    app.sseClients.add(response);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 25000);
    request.on('close', () => { clearInterval(heartbeat); app.sseClients.delete(response); });
    return;
  }
  if (request.method === 'GET' && await serveStatic(url.pathname, response)) return;
  if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  if (!sameOrigin(request)) return sendJson(response, 403, { error: 'This local control endpoint accepts requests only from the dashboard.' });
  try {
    const body = await readJson(request);
    if (url.pathname === '/api/auth/start') {
      const authorizationCredentials = app.credentials ?? (app.state.clientId ? { client_id: app.state.clientId } : null);
      app.authAttempt = makeAuthorizationAttempt({ port, credentials: authorizationCredentials, hostId: app.state.hostId });
      app.state.hostId = app.authAttempt.hostId;
      app.state.authMessage = 'Waiting for authorization in your browser…';
      app.broadcast();
      return sendJson(response, 200, { authorizeUrl: app.authAttempt.authorizeUrl });
    }
    if (url.pathname === '/api/auth/signout') {
      await app.control('stop');
      await app.vault.remove('credentials.dpapi.json');
      app.credentials = null;
      app.state.clientId = null;
      app.state.models = [];
      app.state.gptModel = '';
      app.state.codexModel = '';
      app.state.authMessage = 'ChatGPT was disconnected from this app.';
      await app.persistNow();
      app.broadcast();
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/api/models/refresh') {
      const models = await app.refreshModels();
      return sendJson(response, 200, { models });
    }
    if (url.pathname === '/api/gpt-test') {
      const result = await app.testGpt(body);
      return sendJson(response, 200, result);
    }
    if (url.pathname === '/api/project') {
      const selected = await app.setProjectPath(body.projectPath);
      return sendJson(response, 200, { projectPath: selected });
    }
    if (url.pathname === '/api/tasks') {
      const task = await app.startTask(body);
      return sendJson(response, 202, { taskId: task.id });
    }
    if (url.pathname === '/api/requirements') {
      const result = await app.addRequirement(body);
      return sendJson(response, 202, result);
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/priority')) {
      const taskId = url.pathname.split('/')[3];
      await app.reorderTask(taskId, body.direction);
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/api/control') {
      await app.control(body.action, body.feedback ?? '');
      return sendJson(response, 200, { ok: true });
    }
    return sendJson(response, 404, { error: 'Unknown API endpoint.' });
  } catch (error) {
    const status = error.status ?? 400;
    return sendJson(response, status, { error: error.message ?? 'Request failed.', kind: error.kind ?? null, detail: error.detail ?? null, code: error.code ?? null });
  }
}

await app.init();
const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    if (!response.headersSent) sendJson(response, 500, { error: 'Local app error.', detail: error.message });
    else response.end();
  });
});
server.requestTimeout = 0;
server.headersTimeout = 30000;
server.keepAliveTimeout = 65000;
server.listen(port, '127.0.0.1', () => {
  console.log(`AI Developer Bridge listening at http://127.0.0.1:${port}`);
  console.log(`Encrypted local data: ${app.vault.directory}`);
  if (!app.hasCredentials) console.log('Sign in with ChatGPT from the dashboard before any model request.');
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Close the other local app or set AI_DEV_PORT before starting this app.`
    : error.message);
  process.exitCode = 1;
});

const shutdown = async () => {
  app.close();
  await app.persistNow().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
