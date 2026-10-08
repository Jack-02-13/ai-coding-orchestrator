import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Orchestrator } from './orchestrator.mjs';
import { exchangeCode, makeAuthorizationAttempt, validateTokenResponse } from './oauth.mjs';
import { redactSensitiveText } from './helpers.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicDir = path.join(root, '..', 'public');

function securityHeaders() {
  return {
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8' });
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

export function createBridgeServer({ app, port = 1455, publicDir = defaultPublicDir } = {}) {
  if (!app) throw new Error('An orchestrator instance is required.');
  let server;

  function localAddress() {
    const address = server?.address();
    const activePort = typeof address === 'object' && address ? address.port : port;
    const host = `127.0.0.1:${activePort}`;
    return { host, origin: `http://${host}`, port: activePort };
  }

  function isTrustedRequest(request, url) {
    const expected = localAddress();
    if (request.headers.host !== expected.host) return false;
    const oauthCallback = request.method === 'GET' && url.pathname === '/auth/callback';
    if (oauthCallback) return true;

    const origin = request.headers.origin;
    if (origin !== undefined && origin !== expected.origin) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method) && origin !== expected.origin) return false;
    return true;
  }

  function sendForbidden(request, response) {
    if (request.url?.startsWith('/api/')) return sendJson(response, 403, { error: 'This local app accepts requests only from its own dashboard origin.' });
    response.writeHead(403, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
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
        ...securityHeaders(),
        'content-type': file[1],
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'x-frame-options': 'DENY',
      });
      response.end(content);
      return true;
    } catch { return false; }
  }

  async function authCallback(url, response) {
    const returnToDashboard = () => {
      response.writeHead(303, { ...securityHeaders(), location: '/' });
      response.end();
    };
    const attempt = app.authAttempt;
    if (!attempt) return returnToDashboard();
    if (url.searchParams.get('state') !== attempt.state) {
      // A forged callback must not cancel an in-flight, valid sign-in attempt.
      return returnToDashboard();
    }
    app.authAttempt = null;
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      app.state.authMessage = oauthError === 'access_denied'
        ? 'ChatGPT plan use was not authorized. No model request was sent.'
        : 'OpenAI sign-in was not completed. Start sign-in again.';
      app.state.lastError = { kind: 'auth', message: app.state.authMessage };
      await app.persistNow();
      app.broadcast();
      return returnToDashboard();
    }
    const code = url.searchParams.get('code');
    const issuedClientId = url.searchParams.get('client_id') || (attempt.firstTime ? '' : app.credentials?.client_id ?? app.state.clientId ?? '');
    if (!code || !issuedClientId || (!attempt.firstTime && url.searchParams.has('client_id') && url.searchParams.get('client_id') !== (app.credentials?.client_id ?? app.state.clientId))) {
      app.state.authMessage = 'The callback did not contain the expected authorization code or issued client ID. No credentials were changed.';
      app.state.lastError = { kind: 'auth', message: app.state.authMessage };
      await app.persistNow();
      app.broadcast();
      return returnToDashboard();
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
      app.state.hostId = attempt.hostId;
      app.state.authMessage = 'Connected to ChatGPT; ChatGPT plan usage permission was verified.';
      app.state.lastError = null;
      app.state.planBlocked = false;
      await app.persistNow();
      app.broadcast();
    } catch (error) {
      app.state.authMessage = redactSensitiveText(error.message, [code]);
      app.state.lastError = { kind: 'auth', message: app.state.authMessage };
      await app.persistNow();
      app.broadcast();
    }
    return returnToDashboard();
  }

  async function route(request, response) {
    const url = new URL(request.url, `http://127.0.0.1:${localAddress().port}`);
    if (!isTrustedRequest(request, url)) return sendForbidden(request, response);
    if (request.method === 'GET' && url.pathname === '/auth/callback') return authCallback(url, response);
    if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, app.snapshot());
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, {
        ...securityHeaders(),
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      response.write(`event: state\ndata: ${JSON.stringify(app.snapshot())}\n\n`);
      app.sseClients.add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 25000);
      request.on('close', () => { clearInterval(heartbeat); app.sseClients.delete(response); });
      return;
    }
    if (request.method === 'GET' && await serveStatic(url.pathname, response)) return;
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      response.writeHead(404, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    try {
      const body = await readJson(request);
      if (url.pathname === '/api/auth/start') {
        const authorizationCredentials = app.credentials ?? (app.state.clientId ? { client_id: app.state.clientId } : null);
        app.authAttempt = makeAuthorizationAttempt({ port: localAddress().port, credentials: authorizationCredentials, hostId: app.state.hostId });
        app.state.hostId = app.authAttempt.hostId;
        app.state.authMessage = 'Waiting for authorization in your browser…';
        app.broadcast();
        return sendJson(response, 200, { authorizeUrl: app.authAttempt.authorizeUrl });
      }
      if (url.pathname === '/api/auth/signout') return sendJson(response, 200, await app.signOut());
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
      const secrets = [app.credentials?.access_token, app.credentials?.refresh_token, app.credentials?.id_token];
      const code = error.code === undefined ? null : redactSensitiveText(error.code, secrets).slice(0, 120);
      return sendJson(response, error.status ?? 400, {
        error: redactSensitiveText(error.message ?? 'Request failed.', secrets),
        kind: typeof error.kind === 'string' ? redactSensitiveText(error.kind, secrets).slice(0, 80) : null,
        detail: error.detail ? redactSensitiveText(error.detail, secrets) : null,
        code,
      });
    }
  }

  server = createServer((request, response) => {
    route(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'Local app error. Check the local encrypted application state and restart.' });
      else response.end();
    });
  });
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\nCross-Origin-Resource-Policy: same-origin\r\n\r\n');
  });
  return server;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const port = Number(process.env.AI_DEV_PORT ?? 1455);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AI_DEV_PORT must be a valid TCP port number.');
  const app = new Orchestrator();
  try { await app.init(); }
  catch {
    console.error('Secure local storage could not be initialized. No credential or local path details were logged.');
    process.exit(1);
  }
  const server = createBridgeServer({ app, port });
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 65000;
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI Developer Bridge listening at http://127.0.0.1:${port}`);
    console.log('Local data is protected with Windows DPAPI for the current Windows account.');
    if (!app.hasCredentials) console.log('Sign in with ChatGPT from the dashboard before any model request.');
  });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Close the other local app or set AI_DEV_PORT before starting this app.`
      : `Local server failed to start (${error.code ?? 'unknown error'}).`);
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
}
