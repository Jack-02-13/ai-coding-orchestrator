import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { CodexAppServer } from '../src/codex-app-server.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';

const quotaCode = 'subscription_sharing_usage_limit_exceeded';
const projectPath = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const quotaError = { code: -32603, message: 'Provider request failed', data: { error: { code: quotaCode } } };

// Exercise the real RPC request/response dispatch without spawning Codex or
// making inference, OAuth refresh, or other network requests.
function fakeCodex(t, respond) {
  const codex = new CodexAppServer({ accessToken: 'test-oauth-token' });
  const requests = [];
  const notifications = [];
  t.mock.method(codex, 'start', async () => {});
  codex.proc = {
    stdin: {
      writable: true,
      write(line, callback) {
        const request = JSON.parse(line);
        requests.push(request);
        callback?.();
        queueMicrotask(() => {
          const reply = respond(request);
          codex.handleLine(JSON.stringify({ id: request.id, ...reply.response }));
          if (reply.notification) setImmediate(() => {
            notifications.push(reply.notification);
            codex.handleLine(JSON.stringify(reply.notification));
          });
          if (reply.afterResponse) setImmediate(reply.afterResponse);
        });
      },
      destroy() {},
    },
    kill() {},
  };
  t.after(() => codex.close());
  return { codex, requests, notifications };
}

// Isolate orchestration persistence from the OS DPAPI subprocess. This writes
// only synthetic task state in the project, exercises persistNow/init across
// disk serialization, and leaves production LocalVault encryption unchanged.
function testStateStorage(t, vault, directory) {
  vault.directory = directory;
  t.mock.method(vault, 'write', async (name, value) => {
    assert.equal(name, 'state.dpapi.json');
    await writeFile(vault.file(name), JSON.stringify(value), 'utf8');
  });
  t.mock.method(vault, 'read', async (name, fallback = null) => {
    try { return JSON.parse(await readFile(vault.file(name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  });
}

const quotaEnvelopes = [
  ['a string code on the RPC error', { code: quotaCode, message: 'Usage limit reached' }],
  ['a code in RPC error data', { code: -32000, message: 'Request failed', data: { code: quotaCode } }],
  ['a nested provider error in RPC data', quotaError],
  ['JSON-encoded RPC data', { code: -32603, message: 'Request failed', data: JSON.stringify({ error: { code: quotaCode } }) }],
  ['a provider code in the RPC message', { code: -32603, message: `Request failed: ${quotaCode}` }],
  ['JSON-encoded provider error in the RPC message', { code: -32603, message: JSON.stringify({ error: { code: quotaCode, message: 'Usage limit reached' } }) }],
];

for (const [name, rpcError] of quotaEnvelopes) {
  test(`Codex RPC maps ${name} to a non-retryable quota pause`, async (t) => {
    const { codex, requests } = fakeCodex(t, () => ({ response: { error: rpcError } }));
    await assert.rejects(codex.rpc('turn/start', {}), (error) => {
      assert.equal(error.kind, 'quota');
      assert.equal(error.pause, true);
      assert.equal(error.retryable, false);
      assert.equal(error.code, quotaCode);
      assert.equal(error.rpcCode, rpcError.code);
      assert.equal(error.detail, rpcError.message);
      assert.match(error.message, /manually/);
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(codex.pending.size, 0);
    assert.equal(codex.listeners.size, 0);
  });
}

for (const [code, kind] of [
  ['subscription_sharing_usage_unavailable', 'unavailable'],
  ['subscription_sharing_invalid_user', 'auth'],
]) {
  test(`Codex RPC preserves the ${kind} plan error classification`, async (t) => {
    const { codex } = fakeCodex(t, () => ({ response: { error: { code: -32603, message: 'Request failed', data: { code } } } }));
    await assert.rejects(codex.rpc('thread/resume', {}), (error) => error.kind === kind && error.code === code && error.pause === true);
    assert.equal(codex.pending.size, 0);
  });
}

test('Codex RPC keeps a generic numeric request error distinct from quota', async (t) => {
  const { codex } = fakeCodex(t, () => ({ response: { error: { code: -32602, message: 'Invalid params' } } }));
  await assert.rejects(codex.rpc('turn/start', {}), (error) => {
    assert.equal(error.kind, 'request');
    assert.equal(error.code, -32602);
    assert.equal(error.rpcCode, -32602);
    assert.equal(error.message, 'Invalid params');
    assert.equal(error.pause, true);
    return true;
  });
  assert.equal(codex.pending.size, 0);
});

test('Codex RPC still resolves successful requests and clears pending state', async (t) => {
  const result = { turn: { id: 'turn-ok' } };
  const { codex, requests } = fakeCodex(t, () => ({ response: { result } }));
  assert.deepEqual(await codex.rpc('turn/start', { threadId: 'thread-ok' }), result);
  assert.equal(requests.length, 1);
  assert.equal(codex.pending.size, 0);
});

test('new Codex threads are ephemeral and commands receive a filtered shell environment policy', async (t) => {
  const { codex, requests } = fakeCodex(t, () => ({ response: { result: { thread: { id: 'thread-ephemeral' } } } }));
  await codex.ensureThread({ model: 'account-model', projectPath, savedThreadId: null });
  const request = requests.find((item) => item.method === 'thread/start');
  assert.ok(request);
  assert.equal(request.params.ephemeral, true);
  assert.equal(request.params.config['shell_environment_policy.inherit'], 'core');
  assert.equal(request.params.config['shell_environment_policy.ignore_default_excludes'], false);
  assert.equal(request.params.config.cli_auth_credentials_store, 'ephemeral');
  assert.equal(request.params.config['sandbox_workspace_write.network_access'], false);
});

test('Codex app-server output redacts the ChatGPT access token before it reaches transcript listeners', (t) => {
  const token = 'synthetic-access-token-secret';
  const codex = new CodexAppServer({ accessToken: token });
  const seen = [];
  codex.listeners.add((message) => seen.push(message));
  codex.handleLine(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: `Bearer ${token}` } }));
  assert.equal(seen.length, 1);
  assert.equal(JSON.stringify(seen[0]).includes(token), false);
  assert.match(seen[0].params.delta, /憑證已遮蔽/);
  t.after(() => codex.close());
});

test('Codex stderr redaction catches an OAuth token split across process chunks', (t) => {
  const token = 'synthetic-access-token-secret';
  const seen = [];
  const codex = new CodexAppServer({ accessToken: token, onProgress: (event) => seen.push(event.text) });
  codex.stderrBuffer = `provider error Bearer ${token.slice(0, 11)}`;
  codex.flushStderr();
  codex.stderrBuffer += `${token.slice(11)}\n`;
  codex.flushStderr(true);
  const output = `${codex.stderrText}${seen.join('')}`;
  assert.equal(output.includes(token), false);
  assert.match(output, /憑證已遮蔽/);
  t.after(() => codex.close());
});

test('Codex reports a command as running before its completion event', async (t) => {
  let codex;
  const { codex: instance } = fakeCodex(t, (request) => {
    if (request.method === 'thread/start') return { response: { result: { thread: { id: 'thread-ok' } } } };
    assert.equal(request.method, 'turn/start');
    return {
      response: { result: { turn: { id: 'turn-ok' } } },
      afterResponse: () => {
        codex.handleLine(JSON.stringify({ method: 'item/started', params: { threadId: 'thread-ok', item: { type: 'commandExecution', command: 'npm test' } } }));
        codex.handleLine(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread-ok', item: { type: 'commandExecution', command: 'npm test', status: 'failed', exitCode: 124, durationMs: 300000, aggregatedOutput: 'Error: command timed out' } } }));
        codex.handleLine(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-ok', turn: { id: 'turn-ok', status: 'completed', items: [{ type: 'agentMessage', text: 'Done' }] } } }));
      },
    };
  });
  codex = instance;
  const events = [];
  await codex.runTurn({ model: 'account-model', projectPath, prompt: 'Run tests', onItem: (event) => events.push(event) });

  assert.deepEqual(events.map(({ status }) => status), ['running', 'failed']);
  assert.equal(events[1].exitCode, 124);
  assert.equal(events[1].durationMs, 300000);
  assert.equal(events[1].failureOutput, 'Error: command timed out');
});

for (const savedThreadId of [null, 'saved-thread']) {
  test(`Codex ${savedThreadId ? 'resumed' : 'new'} threads and turns restrict writes to the selected project and disable shell network`, async (t) => {
    const { codex, requests } = fakeCodex(t, (request) => {
      if (request.method.startsWith('thread/')) return { response: { result: { thread: { id: 'thread-ok' } } } };
      assert.equal(request.method, 'turn/start');
      return {
        response: { result: { turn: { id: 'turn-ok' } } },
        notification: { method: 'turn/completed', params: { threadId: 'thread-ok', turn: { id: 'turn-ok', status: 'completed', items: [{ type: 'agentMessage', text: 'Done' }] } } },
      };
    });
    const result = await codex.runTurn({ model: 'account-model', projectPath, savedThreadId, prompt: 'Local task' });
    assert.equal(result.text, 'Done');
    assert.deepEqual(requests.map((request) => request.method), [savedThreadId ? 'thread/resume' : 'thread/start', 'turn/start']);
    const thread = requests[0].params;
    assert.equal(thread.cwd, projectPath);
    assert.equal(thread.approvalPolicy, 'never');
    assert.equal(thread.sandbox, 'workspace-write');
    assert.deepEqual(thread.config['sandbox_workspace_write.writable_roots'], [projectPath]);
    assert.equal(thread.config['sandbox_workspace_write.network_access'], false);
    assert.equal(thread.config['sandbox_workspace_write.exclude_tmpdir_env_var'], true);
    assert.equal(thread.config['sandbox_workspace_write.exclude_slash_tmp'], true);
    const turn = requests[1].params;
    assert.equal(turn.cwd, projectPath);
    assert.equal(turn.approvalPolicy, 'never');
    assert.deepEqual(turn.sandboxPolicy, {
      type: 'workspaceWrite', writableRoots: [projectPath], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    });
    assert.equal(codex.activeTurnId, null);
    assert.equal(codex.listeners.size, 0);
  });
}

test('Codex completed-turn quota errors use the same non-retryable mapping', async (t) => {
  const { codex } = fakeCodex(t, (request) => request.method === 'thread/start'
    ? { response: { result: { thread: { id: 'thread-ok' } } } }
    : {
      response: { result: { turn: { id: 'turn-ok' } } },
      notification: { method: 'turn/completed', params: { threadId: 'thread-ok', turn: { id: 'turn-ok', status: 'failed', error: { code: quotaCode, message: 'Usage limit reached' }, items: [{ type: 'agentMessage', text: 'Partial progress' }] } } },
    });
  await assert.rejects(codex.runTurn({ model: 'account-model', projectPath, prompt: 'Local task' }), (error) => {
    assert.equal(error.kind, 'quota');
    assert.equal(error.pause, true);
    assert.equal(error.retryable, false);
    assert.equal(error.code, quotaCode);
    assert.equal(error.partial, 'Partial progress');
    return true;
  });
  assert.equal(codex.activeTurnId, null);
  assert.equal(codex.listeners.size, 0);
});

for (const [failedMethod, concurrentPause] of [
  ['thread/start', false], ['thread/resume', false], ['turn/start', false], ['turn/start', true],
  ['turn/steer', false], ['turn/interrupt', false],
]) {
  test(`early ${failedMethod} quota errors persist and never auto-resume${concurrentPause ? ', even during a user pause' : ''}`, async (t) => {
    const scratch = await mkdtemp(path.join(fileURLToPath(new URL('.', import.meta.url)), 'quota-test-'));
    const app = new Orchestrator();
    const restored = new Orchestrator();
    testStateStorage(t, app.vault, scratch);
    testStateStorage(t, restored.vault, scratch);
    t.after(async () => {
      app.close();
      restored.close();
      await Promise.allSettled([app.flushChain, restored.flushChain]);
      await rm(scratch, { recursive: true, force: true });
    });
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
    const task = {
      id: 'active-task', description: 'Improve the selected project', prompt: 'Implement and check locally',
      projectPath, gptModel: 'account-model', codexModel: 'account-model', stage: 'codex', status: 'running',
      round: 0, partial: '',
    };
    app.credentials = { access_token: 'test-oauth-token', expires_at: Date.now() + 300_000, scopes: ['chatgpt.tokens.use.direct'] };
    Object.assign(app.state, {
      status: 'running', projectPath, activeTaskId: task.id, models: [{ slug: 'account-model' }],
      tasks: [task, { id: 'queued-task', description: 'Keep queued work untouched', status: 'queued', priority: 'urgent' }],
    });
    if (failedMethod === 'thread/resume') task.codexThreadId = 'saved-thread';
    const { codex, requests, notifications } = fakeCodex(t, (request) => {
      if (request.method === failedMethod) {
        if (concurrentPause) app.pauseRequested = true;
        return { response: { error: quotaError } };
      }
      if (request.method === 'thread/start') return { response: { result: { thread: { id: 'thread-ok' } } } };
      assert.equal(request.method, 'turn/start');
      return {
        response: { result: { turn: { id: 'turn-ok' } } },
        afterResponse: () => {
          const request = failedMethod === 'turn/steer' ? codex.steer('User update') : codex.interrupt();
          request.catch(() => {}); // The active turn must propagate this quota too.
        },
      };
    });
    app.codex = codex;
    app.ensureLoop();
    await app.loopPromise;
    assert.equal(app.loopPromise, null);
    assert.equal(app.state.status, 'paused');
    assert.equal(app.state.planBlocked, true);
    assert.equal(app.pauseRequested, true);
    assert.equal(app.state.lastError.kind, 'quota');
    assert.equal(app.state.lastError.code, quotaCode);
    assert.equal(task.status, 'paused');
    assert.equal(task.stage, 'codex');
    assert.equal(task.round, 0);
    assert.equal(app.state.tasks[1].status, 'queued');
    const expectedMethods = failedMethod.startsWith('thread/') ? [failedMethod]
      : failedMethod === 'turn/start' ? ['thread/start', 'turn/start']
      : ['thread/start', 'turn/start', failedMethod];
    assert.deepEqual(requests.map((request) => request.method), expectedMethods);
    assert.equal(notifications.length, 0, 'No turn/completed notification was needed to pause');
    assert.equal(codex.activeTurnId, null);
    assert.equal(codex.pending.size, 0);
    assert.equal(codex.listeners.size, 0);
    const saved = await app.vault.read('state.dpapi.json');
    assert.equal(saved.status, 'paused');
    assert.equal(saved.planBlocked, true);
    assert.equal(saved.lastError.kind, 'quota');
    assert.equal(saved.lastError.code, quotaCode);
    assert.equal(saved.tasks[0].status, 'paused');
    assert.equal(saved.tasks[0].prompt, task.prompt);
    assert.equal(saved.tasks[1].status, 'queued');

    const phaseMock = t.mock.method(restored, 'runTaskPhase', async () => { throw new Error('Unexpected automatic task retry'); });
    await restored.init();
    assert.equal(restored.state.status, 'paused');
    assert.equal(restored.state.planBlocked, true);
    assert.equal(restored.state.lastError.kind, 'quota');
    app.ensureLoop();
    restored.ensureLoop();
    assert.equal(app.loopPromise, null);
    assert.equal(restored.loopPromise, null);
    // Even a stale running state must not restart inference or select queued work.
    restored.state.status = 'running';
    restored.ensureLoop();
    assert.equal(restored.loopPromise, null);
    await restored.runLoop();
    assert.equal(restored.state.status, 'paused');
    assert.equal(phaseMock.mock.callCount(), 0);
    restored.credentials = { ...app.credentials, expires_at: 0 };
    await assert.rejects(restored.runCodex(restored.getActiveTask()), (error) => error.kind === 'paused');
    await assert.rejects(restored.refreshModels(), /Click Continue manually/);
    await assert.rejects(restored.testGpt({ model: 'account-model' }), (error) => error.kind === 'paused');
    await assert.rejects(restored.startTask({ text: 'Another task', projectPath, gptModel: 'account-model', codexModel: 'account-model' }), /Click Continue manually/);
    assert.equal(fetchMock.mock.callCount(), 0, 'A quota pause also blocks token refresh');
    assert.equal(requests.filter((request) => request.method === failedMethod).length, 1);
    await restored.setError(new Error('Unrelated local error while paused'));
    assert.equal(restored.state.planBlocked, true);
    assert.equal(restored.state.lastError.kind, 'quota');
    assert.equal((await restored.vault.read('state.dpapi.json')).lastError.code, quotaCode);

    // Explicit human resume remains the only way to clear the plan pause.
    const resumeMock = t.mock.method(restored, 'ensureLoop', () => {});
    await restored.control('resume');
    assert.equal(restored.state.planBlocked, false);
    assert.equal(restored.state.lastError, null);
    assert.equal(restored.getActiveTask().status, 'running');
    assert.equal(resumeMock.mock.callCount(), 1);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test('manual resume clears a quota pause before refreshing an empty model catalog', async (t) => {
  const scratch = await mkdtemp(path.join(fileURLToPath(new URL('.', import.meta.url)), 'resume-test-'));
  const app = new Orchestrator();
  testStateStorage(t, app.vault, scratch);
  t.after(async () => {
    app.close();
    await app.flushChain;
    await rm(scratch, { recursive: true, force: true });
  });

  app.credentials = { access_token: 'test-oauth-token', scopes: ['chatgpt.tokens.use.direct'] };
  app.state.status = 'paused';
  app.state.planBlocked = true;
  app.state.lastError = { kind: 'quota', message: 'Usage limit reached', code: quotaCode };
  app.pauseRequested = true;
  const refresh = t.mock.method(app, 'refreshModels', async () => {
    assert.equal(app.state.planBlocked, false, 'manual resume must unlock its one catalog refresh');
    app.state.models = [{ slug: 'account-model' }];
    return app.state.models;
  });
  const loop = t.mock.method(app, 'ensureLoop', () => {});

  await app.control('resume');

  assert.equal(refresh.mock.callCount(), 1);
  assert.equal(app.state.planBlocked, false);
  assert.equal(app.state.lastError, null);
  assert.equal(app.state.status, 'idle');
  assert.equal(app.pauseRequested, false);
  assert.equal(loop.mock.callCount(), 1);
});
