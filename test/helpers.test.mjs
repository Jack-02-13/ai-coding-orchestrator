import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { extractSseEvents, makeResponsesPayload, classifyPlanFailure, parseDecision } from '../src/helpers.mjs';
import { makeAuthorizationAttempt } from '../src/oauth.mjs';
import { ensureFreshPlanToken, PlanRequestError, streamResponse } from '../src/openai-plan.mjs';
import { LocalVault } from '../src/vault.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';

test('project path accepts a quoted folder copied from Windows', async (t) => {
  const app = new Orchestrator();
  t.mock.method(app.vault, 'write', async () => {});
  t.after(() => app.close());

  const expected = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const selected = await app.setProjectPath(`  "${expected}"  `);

  assert.equal(selected, expected);
  assert.equal(app.state.projectPath, expected);
});

test('a new task queues behind a result awaiting human acceptance without starting inference', async (t) => {
  const app = new Orchestrator();
  t.mock.method(app.vault, 'write', async () => {});
  t.after(() => app.close());
  app.credentials = { access_token: 'test-oauth-token' };
  app.state.models = [{ slug: 'account-model', name: 'Account model' }];
  app.state.status = 'review';
  app.state.activeTaskId = 'awaiting-review';
  app.state.tasks = [{ id: 'awaiting-review', status: 'review' }];
  t.mock.method(app, 'setProjectPath', async (value) => value);
  const loop = t.mock.method(app, 'ensureLoop', () => {});

  const task = await app.startTask({
    text: 'Write a Python script that prints banana.',
    projectPath: path.join(path.parse(process.cwd()).root, 'ai-developer-test-project'),
    gptModel: 'account-model',
    codexModel: 'account-model',
  });

  assert.equal(task.status, 'queued');
  assert.equal(app.state.tasks.length, 2);
  assert.equal(app.state.status, 'review');
  assert.equal(app.state.activeTaskId, 'awaiting-review');
  assert.equal(loop.mock.callCount(), 1);
  assert.equal(app.loopPromise, null, 'the review gate prevents inference until human acceptance');

  await app.control('accept');
  assert.equal(app.state.status, 'running');
  assert.equal(app.state.activeTaskId, null);
  assert.equal(loop.mock.callCount(), 2, 'human acceptance releases the queued task to the loop');
});

test('authorization attempts use a stable local callback, fresh PKCE, and required plan scopes', () => {
  const first = makeAuthorizationAttempt({ port: 1455, credentials: null });
  const second = makeAuthorizationAttempt({ port: 1455, credentials: null });
  const url = new URL(first.authorizeUrl);
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.match(url.searchParams.get('scope'), /chatgpt\.tokens\.use\.direct/);
  assert.equal(url.searchParams.get('ext_agent_host_id'), first.hostId);
  assert.match(first.hostId, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first.state, second.state);
  assert.notEqual(url.searchParams.get('code_challenge'), new URL(second.authorizeUrl).searchParams.get('code_challenge'));
});

test('returning authorization reuses issued client ID, host ID, and retained ID token', () => {
  const credentials = { client_id: 'oaiapp_existing', ext_agent_host_id: 'urn:uuid:abc', id_token: 'previous-id-token' };
  const attempt = makeAuthorizationAttempt({ port: 1455, credentials });
  const url = new URL(attempt.authorizeUrl);
  assert.equal(url.searchParams.get('client_id'), credentials.client_id);
  assert.equal(url.searchParams.get('ext_agent_host_id'), credentials.ext_agent_host_id);
  assert.equal(url.searchParams.get('id_token_hint'), credentials.id_token);
  assert.equal(url.searchParams.has('agent_name_hint'), false);
});

test('a host identifier prepared by the app is reused across fresh OAuth attempts', () => {
  const hostId = 'urn:uuid:fe42d302-49d4-4d01-a34c-7b74299d5cb1';
  const first = makeAuthorizationAttempt({ port: 1455, credentials: null, hostId });
  const retry = makeAuthorizationAttempt({ port: 1455, credentials: null, hostId });
  assert.equal(first.hostId, hostId);
  assert.equal(retry.hostId, hostId);
  assert.equal(new URL(retry.authorizeUrl).searchParams.get('ext_agent_host_id'), hostId);
});

test('Responses plan requests always have store=false and stream=true', () => {
  const body = makeResponsesPayload('model-slug', [{ role: 'user', content: 'hello' }], 'instructions');
  assert.equal(body.model, 'model-slug');
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.input[0].content, 'hello');
});

test('Responses API stream uses the public endpoint, bearer OAuth, and succeeds only at response.completed', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  const output = [
    { type: 'response.output_text.delta', delta: 'Hello ' },
    { type: 'response.output_text.delta', delta: 'world' },
    { type: 'response.completed' },
  ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(output, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    let streamed = '';
    const result = await streamResponse({
      credentials: { access_token: 'oauth-token', expires_at: Date.now() + 300_000 },
      model: 'account-model', messages: [{ role: 'user', content: 'hello' }], instructions: 'test instructions',
      onDelta: (_delta, all) => { streamed = all; }, onRefresh: async () => {},
    });
    assert.equal(result, 'Hello world');
    assert.equal(streamed, result);
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.options.headers.authorization, 'Bearer oauth-token');
    assert.equal(request.body.store, false);
    assert.equal(request.body.stream, true);
    assert.equal(request.options.headers['x-api-key'], undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('Responses quota failures pause and are never retried automatically', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } });
  };
  try {
    await assert.rejects(streamResponse({
      credentials: { access_token: 'oauth-token', expires_at: Date.now() + 300_000 }, model: 'account-model',
      messages: [{ role: 'user', content: 'hello' }], instructions: 'test instructions', onDelta: async () => {}, onRefresh: async () => {},
    }), (error) => error instanceof PlanRequestError && error.kind === 'quota' && error.pause === true);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('Codex receives a refreshed ChatGPT plan token before app-server inference', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, body: new URLSearchParams(options.body) };
    return new Response(JSON.stringify({
      access_token: 'fresh-oauth-token', refresh_token: 'rotated-refresh-token', expires_in: 3600,
      scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    let saved;
    const fresh = await ensureFreshPlanToken({
      access_token: 'old-oauth-token', refresh_token: 'old-refresh-token', client_id: 'oaiapp_existing',
      expires_at: Date.now() - 1000, scopes: ['chatgpt.tokens.use.direct'],
    }, async (updated) => { saved = updated; });
    assert.equal(request.url, 'https://auth.openai.com/api/accounts/oauth/token');
    assert.equal(request.body.get('grant_type'), 'refresh_token');
    assert.equal(request.body.get('client_id'), 'oaiapp_existing');
    assert.equal(request.body.get('refresh_token'), 'old-refresh-token');
    assert.equal(request.body.get('resource'), 'https://api.openai.com/v1');
    assert.equal(fresh.access_token, 'fresh-oauth-token');
    assert.equal(fresh.refresh_token, 'rotated-refresh-token');
    assert.equal(saved, fresh);
  } finally { globalThis.fetch = originalFetch; }
});

test('SSE parser emits complete JSON events and retains an incomplete trailing block', () => {
  const parsed = extractSseEvents('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' + 'data: {"type":"response.completed"}');
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].delta, 'hi');
  assert.equal(parsed.remainder, 'data: {"type":"response.completed"}');
});

test('subscription quota failure pauses without inventing a reset time', () => {
  const result = classifyPlanFailure(429, { error: { code: 'subscription_sharing_usage_limit_exceeded' } });
  assert.equal(result.kind, 'quota');
  assert.equal(result.pause, true);
  assert.match(result.message, /manually/);
});

test('a quota pause blocks model refresh, GPT test, and task starts until manual resume', async () => {
  const app = new Orchestrator();
  app.credentials = { access_token: 'oauth-token', scopes: ['chatgpt.tokens.use.direct'] };
  app.state.planBlocked = true;
  await assert.rejects(app.refreshModels(), /Click Continue manually/);
  await assert.rejects(app.testGpt({ model: 'account-model' }), (error) => error.kind === 'paused');
  await assert.rejects(app.startTask({ text: 'blocked', gptModel: 'account-model', codexModel: 'account-model' }), /Click Continue manually/);
  assert.equal(app.state.messages.length, 0);
});

test('GPT decisions require a well-formed explicit result marker', () => {
  assert.deepEqual(parseDecision('No marker; treat as human input.'), { action: 'human', summary: 'No marker; treat as human input.', nextPrompt: '' });
  const result = parseDecision('Plan.\n<result>{"action":"continue","summary":"Need tests","next_prompt":"Add tests","acceptance_criteria":["green"]}</result>');
  assert.equal(result.action, 'continue');
  assert.equal(result.nextPrompt, 'Add tests');
  assert.deepEqual(result.acceptanceCriteria, ['green']);
  const chinese = parseDecision('<result>{"action":"review","summary":"功能已完成，測試通過。","next_prompt":""}</result>');
  assert.equal(chinese.action, 'review');
  assert.equal(chinese.summary, '功能已完成，測試通過。');
});

test('local progress and credentials can be round-tripped through the current-user vault', async () => {
  const scratch = await mkdtemp(path.join(fileURLToPath(new URL('.', import.meta.url)), 'vault-test-'));
  const vault = new LocalVault();
  vault.directory = scratch;
  const value = { access_token: 'do-not-store-this-in-plain-text', transcript: '私有開發任務紀錄' };
  try {
    await vault.write('test.dpapi.json', value);
    const stored = await readFile(vault.file('test.dpapi.json'), 'utf8');
    if (process.platform === 'win32') assert.equal(stored.includes(value.access_token), false);
    await vault.write('test.dpapi.json', { ...value, transcript: '已更新的任務狀態' });
    assert.deepEqual(await vault.read('test.dpapi.json'), { ...value, transcript: '已更新的任務狀態' });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
