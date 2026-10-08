import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { APP_NAME, classifyPlanFailure } from './helpers.mjs';

function jsonPayload(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function codexRequestError(rpcError) {
  const data = jsonPayload(rpcError.data);
  const messagePayload = jsonPayload(rpcError.message);
  const codes = [data?.error?.code, data?.code, messagePayload?.error?.code, messagePayload?.code, rpcError.code]
    .filter((code) => typeof code === 'string');
  // JSON-RPC's numeric code is a transport error, not the plan error code.
  // Codex may place the provider error in data or include it in the message.
  const planCodePattern = /\b(?:subscription_sharing_[a-z_]+|chatpass_v2_[a-z_]+)\b/;
  const detail = rpcError.message ?? data?.error?.message ?? data?.message ?? JSON.stringify(rpcError);
  const code = codes.find((value) => planCodePattern.test(value))
    ?? [detail, data?.error?.message, data?.message, rpcError.data].filter((value) => typeof value === 'string')
      .map((value) => value.match(planCodePattern)?.[0]).find(Boolean)
    ?? codes[0] ?? rpcError.code ?? null;
  const recovery = classifyPlanFailure(0, { error: { code, message: detail } });
  return Object.assign(new Error(recovery.message), recovery, {
    code, detail, rpcCode: rpcError.code ?? null, retryable: false,
  });
}

function resolveCodexCommand() {
  const result = spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true });
  const candidates = (result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const executable = candidates.find((line) => /\.exe$/i.test(line));
  if (executable) return { file: executable, prefixArgs: [] };
  if (process.platform === 'win32') {
    const script = candidates.find((line) => /\.ps1$/i.test(line));
    if (script) return {
      file: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe',
      prefixArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    };
  }
  if (result.status === 0) {
    const command = candidates.find((line) => !/\.(?:ps1|cmd)$/i.test(line));
    if (command) return { file: command, prefixArgs: [] };
  }
  throw new Error('Codex CLI was not found. Install the official Codex CLI, then restart this app. No model request was made.');
}

export class CodexAppServer {
  constructor({ accessToken, onProgress }) {
    if (!accessToken) throw new Error('Codex app-server cannot start without the ChatGPT plan OAuth token.');
    this.accessToken = accessToken;
    this.onProgress = onProgress;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.threadId = null;
    this.activeTurnId = null;
    this.stderrText = '';
    this.lineInterface = null;
  }

  async start() {
    if (this.proc) return;
    const env = { ...process.env, ACCESS_TOKEN: this.accessToken };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.CODEX_API_KEY_FILE;
    const args = [
      'app-server', '--listen', 'stdio://',
      '-c', 'model_provider="openai_chatgpt_plan"',
      '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
      '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
      '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
      '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"',
      '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
      '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false',
    ];
    if (process.platform === 'win32') args.push('-c', 'windows.sandbox="unelevated"');
    const command = resolveCodexCommand();
    this.proc = spawn(command.file, [...command.prefixArgs, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stderr.setEncoding('utf8').on('data', (chunk) => {
      const safeChunk = chunk.split(this.accessToken).join('[redacted OAuth token]');
      this.stderrText = `${this.stderrText}${safeChunk}`.slice(-8000);
      this.onProgress?.({ kind: 'codex_log', text: safeChunk.slice(0, 1000) });
    });
    const child = this.proc;
    const lines = createInterface({ input: child.stdout });
    this.lineInterface = lines;
    lines.on('line', (line) => this.handleLine(line));
    lines.on('close', () => { if (this.lineInterface === lines) this.lineInterface = null; });
    child.on('error', (error) => this.failPending(error));
    child.on('exit', (code, signal) => {
      const error = new Error(`Codex app-server exited (${signal ?? code}). ${this.stderrText.slice(-1200)}`);
      this.failPending(error);
      if (this.proc === child) this.proc = null;
      lines.close();
      this.emit({ method: 'bridge/codexExit', params: { code, signal } });
    });
    await this.rpc('initialize', { clientInfo: { name: APP_NAME, title: APP_NAME, version: '0.1.0' } }, 30000);
    this.notify('initialized', {});
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      this.onProgress?.({ kind: 'codex_log', text: line.slice(0, 1000) });
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = codexRequestError(message.error);
        pending.reject(error);
        // A control request can fail while runTurn is waiting for completion.
        // Quota must also end that wait, even if turn/completed never arrives.
        if (error.kind === 'quota') this.emit({ method: 'bridge/quotaPause', params: { error } });
      }
      else pending.resolve(message.result ?? {});
    }
    if (message.method) this.emit(message);
  }

  emit(message) { for (const listener of [...this.listeners]) listener(message); }
  failPending(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }

  notify(method, params) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  rpc(method, params, timeoutMs = 120000) {
    if (!this.proc?.stdin.writable) return Promise.reject(new Error('Codex app-server is not connected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex app-server request timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  async ensureThread({ model, projectPath, savedThreadId }) {
    await this.start();
    const configuration = {
      model, cwd: projectPath, approvalPolicy: 'never', sandbox: 'workspace-write', serviceName: 'ai_developer_bridge',
      config: {
        'sandbox_workspace_write.writable_roots': [projectPath],
        'sandbox_workspace_write.network_access': false,
        'sandbox_workspace_write.exclude_tmpdir_env_var': true,
        'sandbox_workspace_write.exclude_slash_tmp': true,
      },
    };
    let result;
    if (savedThreadId) {
      try { result = await this.rpc('thread/resume', { ...configuration, threadId: savedThreadId }); }
      catch (error) {
        if (error.pause) throw error;
        this.onProgress?.({ kind: 'codex_log', text: `Previous Codex thread could not resume; starting a new thread: ${error.message}` });
      }
    }
    if (!result) result = await this.rpc('thread/start', configuration);
    this.threadId = result.thread?.id ?? savedThreadId;
    if (!this.threadId) throw new Error('Codex app-server did not return a thread id.');
    return this.threadId;
  }

  async runTurn({ model, projectPath, savedThreadId, prompt, signal, onDelta, onItem, onActivity, onThread }) {
    const threadId = await this.ensureThread({ model, projectPath, savedThreadId });
    onThread?.(threadId);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const result = await this.rpc('turn/start', {
      threadId, input: [{ type: 'text', text: prompt }], cwd: projectPath, approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [projectPath], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, model,
    });
    this.activeTurnId = result.turn?.id ?? null;
    if (!this.activeTurnId) throw new Error('Codex app-server did not return a turn id.');
    return await new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const cleanup = () => { this.listeners.delete(listener); signal?.removeEventListener('abort', abort); };
      const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); this.activeTurnId = null; fn(value); };
      const abort = () => { this.interrupt().catch(() => {}); };
      const listener = (message) => {
        const params = message.params ?? {};
        if (params.threadId && params.threadId !== threadId) return;
        onActivity?.(message.method);
        if (message.method === 'item/agentMessage/delta') {
          const delta = params.delta ?? '';
          output += delta;
          onDelta?.(delta, output);
        } else if (message.method === 'item/started') {
          const item = params.item;
          if (item?.type === 'commandExecution') onItem?.({ kind: 'command', text: item.command ?? 'command', status: 'running' });
          else if (item?.type) onItem?.({ kind: item.type, text: item.title ?? item.type, status: 'running' });
        } else if (message.method === 'item/completed') {
          const item = params.item;
          if (item?.type === 'commandExecution') onItem?.({
            kind: 'command', text: item.command ?? 'command', status: item.status ?? '',
            exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
            durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
            failureOutput: item.status === 'failed' ? item.aggregatedOutput ?? item.output ?? '' : '',
          });
          else if (item?.type) onItem?.({ kind: item.type, text: item.title ?? item.type, status: item.status ?? '' });
        } else if (message.method === 'turn/completed') {
          const turn = params.turn ?? {};
          if (turn.id && turn.id !== this.activeTurnId) return;
          const finalText = (turn.items ?? []).filter((item) => item.type === 'agentMessage').map((item) => item.text ?? '').join('\n');
          const text = output || finalText;
          if (turn.status === 'completed') finish(resolve, { text, status: turn.status, turnId: turn.id });
          else {
            const detail = turn.error?.message ?? turn.error?.code ?? `Codex turn ended with status ${turn.status ?? 'unknown'}.`;
            const error = codexRequestError({ ...turn.error, message: detail });
            Object.assign(error, { partial: text, codexStatus: turn.status });
            finish(reject, error);
          }
        } else if (message.method === 'bridge/quotaPause') finish(reject, params.error);
        else if (message.method === 'bridge/codexExit') finish(reject, new Error('Codex app-server exited during a turn.'));
      };
      this.listeners.add(listener);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async steer(text) {
    if (!this.threadId || !this.activeTurnId) return false;
    await this.rpc('turn/steer', { threadId: this.threadId, expectedTurnId: this.activeTurnId, input: [{ type: 'text', text }] }, 30000);
    return true;
  }

  async interrupt() {
    if (!this.threadId || !this.activeTurnId) return;
    await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId }, 10000);
  }

  close() {
    this.failPending(new Error('Codex app-server closed.'));
    const child = this.proc;
    this.proc = null;
    this.lineInterface?.close();
    this.lineInterface = null;
    if (child) {
      const pid = child.pid;
      child.kill();
      if (process.platform === 'win32' && pid) {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    this.listeners.clear();
  }
}
