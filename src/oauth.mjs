import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { APP_NAME, AUTH_BASE, REQUIRED_PLAN_SCOPE } from './helpers.mjs';

const RESOURCE = 'https://api.openai.com/v1';
const ISSUER = 'https://auth.openai.com';
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
const randomString = (length = 48) => randomBytes(length).toString('base64url');

export function makeAuthorizationAttempt({ port, credentials, hostId: savedHostId }) {
  const state = randomString();
  const nonce = randomString();
  const verifier = randomString(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const firstTime = !credentials?.client_id;
  const hostId = credentials?.ext_agent_host_id ?? savedHostId ?? `urn:uuid:${randomUUID()}`;
  const params = new URLSearchParams({
    client_id: firstTime ? 'dynamic_agent_client' : credentials.client_id,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    ext_agent_host_id: hostId,
  });
  if (firstTime) params.set('agent_name_hint', APP_NAME);
  else if (credentials?.id_token) params.set('id_token_hint', credentials.id_token);
  else if (credentials?.email) params.set('login_hint', credentials.email);
  return {
    state, nonce, verifier, redirectUri, firstTime, hostId,
    authorizeUrl: `https://auth.openai.com/api/accounts/authorize?${params.toString()}`,
  };
}

export async function exchangeCode({ code, clientId, verifier, redirectUri }) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
  const response = await fetch(`${AUTH_BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error_description ?? payload?.error ?? `OAuth token exchange failed (HTTP ${response.status}).`);
  return payload;
}

export async function refreshAccessToken(credentials) {
  if (!credentials.refresh_token) throw new Error('No refresh token is available. Sign in with ChatGPT again.');
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token, client_id: credentials.client_id, resource: RESOURCE });
  const response = await fetch(`${AUTH_BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error_description ?? payload?.error ?? `OAuth refresh failed (HTTP ${response.status}).`);
  const scopes = String(payload.scope ?? credentials.scopes.join(' ')).split(/\s+/).filter(Boolean);
  if (!scopes.includes(REQUIRED_PLAN_SCOPE)) throw new Error('The refreshed grant no longer includes chatgpt.tokens.use.direct. Sign in again and approve ChatGPT plan usage.');
  return {
    ...credentials,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? credentials.refresh_token,
    token_type: payload.token_type ?? 'Bearer',
    expires_at: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
    scopes,
  };
}

export async function validateTokenResponse(token, { clientId, nonce, previousSubject = null, hostId }) {
  if (!token.id_token) throw new Error('OAuth succeeded without an ID token; sign-in cannot be validated.');
  const { payload } = await jwtVerify(token.id_token, JWKS, {
    issuer: ISSUER,
    audience: clientId,
    requiredClaims: ['sub', 'exp', 'iat'],
    clockTolerance: 5,
  });
  if (payload.nonce !== nonce) throw new Error('OAuth ID token nonce did not match this sign-in attempt.');
  if (!payload.sub) throw new Error('OAuth ID token did not include a subject.');
  if (previousSubject && payload.sub !== previousSubject) throw new Error('The selected ChatGPT account changed during reauthorization. Credentials were not replaced.');
  const scopes = String(token.scope ?? '').split(/\s+/).filter(Boolean);
  if (!scopes.includes(REQUIRED_PLAN_SCOPE)) throw new Error('Sign-in completed, but ChatGPT plan usage permission was not granted. No model request was sent.');
  if (!token.access_token) throw new Error('OAuth token response did not include an access token.');
  return {
    email: typeof payload.email === 'string' ? payload.email : '', subject: payload.sub, issuer: ISSUER,
    client_id: clientId, ext_agent_host_id: hostId, id_token: token.id_token, access_token: token.access_token,
    refresh_token: token.refresh_token, token_type: token.token_type ?? 'Bearer',
    expires_at: Date.now() + Number(token.expires_in ?? 3600) * 1000, scopes,
  };
}
