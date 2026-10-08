import { randomUUID } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { CodexAppServer } from './codex-app-server.mjs';
import { parseDecision } from './helpers.mjs';
import { ensureFreshPlanToken, listAvailableModels, PlanRequestError, streamResponse } from './openai-plan.mjs';
import { LocalVault } from './vault.mjs';

const GPT_INSTRUCTIONS = `你是本機 GPT ↔ Codex 開發流程的 GPT 管理者。請保留使用者完整需求，將工作整理成 Codex 可執行的步驟，再根據 Codex 實際回報審查結果。除非 Codex 提供證據，否則不得宣稱測試通過。不得建議 API Key、付費 API fallback、發布、洩漏秘密或修改所選專案以外的檔案。

所有面向使用者的內容一律使用繁體中文（台灣用語），包括規劃、摘要、給 Codex 的指示、審查、進度說明、問題與驗收建議。保留程式碼、檔名、路徑、命令、測試名稱、JSON 欄位名稱和錯誤代碼原文，並以繁體中文說明其意義。

每次回覆結尾必須且只能有一個 <result> JSON 物件 </result>。JSON 欄位名稱與 action 值請維持下列英文原樣；其他文字值一律使用繁體中文。
初次規劃或需要 Codex 繼續時：{"action":"continue","summary":"繁體中文的一行摘要","next_prompt":"繁體中文的具體可執行指示","acceptance_criteria":["繁體中文驗收條件"]}。
工作完成、需要使用者檢查時：{"action":"review","summary":"繁體中文說明完成項目與剩餘事項","next_prompt":""}。
遇到阻礙或需要人工處理時：{"action":"human","summary":"繁體中文說明需要使用者採取的行動","next_prompt":""}。
審查時若驗收條件未完成，請提供明確的繁體中文 next_prompt 讓 Codex 繼續；只有 Codex 提供可核實的完成結果，或剩餘步驟確實是人工驗收時，才選擇 review。`;

const CODEX_PREFIX = `你是 AI Developer Bridge 的 Codex 開發代理。你已獲准只在使用者選定的本機專案目錄內檢查、修改檔案並執行相關檢查。遵守專案既有指示，保留無關變更。不得發布、推送、commit、讀寫所選專案以外的內容、使用 API Key 或付費服務。

所有面向使用者的進度、活動摘要、測試結果、完成報告、問題與阻礙一律使用繁體中文（台灣用語）。精確回報實際修改內容、實際執行的命令與測試、結果及阻礙；未驗證的內容要清楚標示。程式碼、檔名、路徑、命令、測試名稱、原始輸出與錯誤代碼請保留原文，並用繁體中文簡短解釋。`;

function freshState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    hostId: `urn:uuid:${randomUUID()}`,
    clientId: null,
    status: 'idle',
    projectPath: '',
    gptModel: '',
    codexModel: '',
    models: [],
    maxRounds: 8,
    activeTaskId: null,
    tasks: [],
    messages: [],
    gptHistory: [],
    codexThreads: {},
    stage: '',
    lastError: null,
    planBlocked: false,
    queuedPriority: 'normal',
  };
}

function priorityRank(priority) { return ({ urgent: 4, high: 3, normal: 2, low: 1 })[priority] ?? 2; }

function codexActivityText(event) {
  const kindLabels = {
    command: '執行指令',
    fileChange: '檔案變更',
    mcpToolCall: '工具呼叫',
    webSearch: '搜尋活動',
    reasoning: '思考步驟',
  };
  const statusLabels = { completed: '已完成', failed: '失敗', running: '執行中', inProgress: '進行中' };
  const label = kindLabels[event.kind] ?? 'Codex 活動';
  const status = event.status ? `（${statusLabels[event.status] ?? event.status}）` : '';
  const detail = event.kind === 'command' ? `：${event.text}` : '';
  const diagnostics = [];
  if (event.kind === 'command' && event.status === 'failed') {
    if (Number.isInteger(event.exitCode)) diagnostics.push(`退出碼：${event.exitCode}`);
    if (Number.isFinite(event.durationMs)) diagnostics.push(`執行時間：${(event.durationMs / 1000).toFixed(1)} 秒`);
    const lines = String(event.failureOutput ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const errors = lines.filter((line) => /timeout|timed[ -]?out|ETIMEDOUT|\berror\b|\bfailed\b|逾時|超時|失敗/i.test(line)).slice(-4);
    const excerpt = errors.join(' | ').slice(-600)
      .replace(/(bearer\s+)[a-z0-9._~+/-]+=*/gi, '$1[憑證已遮蔽]')
      .replace(/\b(?:sk-[a-z0-9_-]{12,}|oai[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{12,}|github_pat_[a-z0-9_]+)/gi, '[憑證已遮蔽]')
      .replace(/\b((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[憑證已遮蔽]');
    if (excerpt) diagnostics.push(`錯誤摘要：${excerpt}`);
  }
  return `${label}${status}${detail}${diagnostics.length ? `\n${diagnostics.join('\n')}` : ''}`;
}

function normalizeProjectPathInput(value) {
  let candidate = value.trim();
  if (candidate.length >= 2 && (
    (candidate.startsWith('"') && candidate.endsWith('"'))
    || (candidate.startsWith("'") && candidate.endsWith("'"))
  )) candidate = candidate.slice(1, -1).trim();
  return candidate;
}

export class Orchestrator {
  constructor() {
    this.vault = new LocalVault();
    this.state = freshState();
    this.credentials = null;
    this.authAttempt = null;
    this.sseClients = new Set();
    this.loopPromise = null;
    this.abortController = null;
    this.codex = null;
    this.flushTimer = null;
    this.flushChain = Promise.resolve();
    this.pauseRequested = false;
    this.stopRequested = false;
    this.activeTask = null;
    this.gptTestActive = false;
  }

  async init() {
    await this.vault.init();
    this.credentials = await this.vault.read('credentials.dpapi.json', null);
    this.state = { ...freshState(), ...(await this.vault.read('state.dpapi.json', {})) };
    this.state.models = Array.isArray(this.state.models) ? this.state.models : [];
    this.state.tasks = Array.isArray(this.state.tasks) ? this.state.tasks : [];
    this.state.messages = Array.isArray(this.state.messages) ? this.state.messages : [];
    this.state.gptHistory = Array.isArray(this.state.gptHistory) ? this.state.gptHistory : [];
    this.state.codexThreads = this.state.codexThreads ?? {};
    const activeTask = this.state.tasks.find((task) => task.id === this.state.activeTaskId);
    // Older versions kept one shared manager history and one Codex thread per folder.
    // Preserve that context for the active task only; new tasks get isolated histories.
    if (activeTask) {
      activeTask.gptHistory ??= this.state.gptHistory;
      activeTask.codexThreadId ??= this.state.codexThreads[activeTask.projectPath] ?? null;
    }
    for (const task of this.state.tasks) task.gptHistory = Array.isArray(task.gptHistory) ? task.gptHistory : [];
    this.state.gptHistory = [];
    this.state.codexThreads = {};
    this.state.hostId = this.credentials?.ext_agent_host_id ?? this.state.hostId ?? `urn:uuid:${randomUUID()}`;
    this.state.clientId = this.credentials?.client_id ?? this.state.clientId ?? null;
    if (this.state.status === 'running' || this.state.status === 'pausing') {
      this.state.status = 'paused';
      this.state.lastError = { kind: 'restart', message: 'App restarted during a task. Progress was restored; click Continue to make another AI request.' };
    }
    await this.persistNow();
  }

  snapshot() {
    const data = structuredClone(this.state);
    const current = this.credentials;
    data.auth = current ? {
      connected: true,
      email: current.email || '',
      scopes: current.scopes ?? [],
      expiresAt: current.expires_at,
      planUsageEnabled: (current.scopes ?? []).includes('chatgpt.tokens.use.direct'),
    } : { connected: false, email: '', scopes: [], planUsageEnabled: false };
    data.storageLocation = this.vault.directory;
    data.codexAvailable = true;
    return data;
  }

  broadcast(type = 'state') {
    const message = `event: ${type}\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const response of [...this.sseClients]) {
      try { response.write(message); } catch { this.sseClients.delete(response); }
    }
  }

  addEvent(role, content, extra = {}) {
    const item = { id: randomUUID(), role, content, createdAt: new Date().toISOString(), ...extra };
    this.state.messages.push(item);
    this.broadcast('message');
    this.persistSoon();
    return item;
  }

  persistSoon() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.persistNow().catch((error) => this.setError(error)); }, 350);
  }

  persistNow() {
    const copy = structuredClone(this.state);
    this.flushChain = this.flushChain.then(() => this.vault.write('state.dpapi.json', copy));
    return this.flushChain;
  }

  async setError(error) {
    // Keep the persisted quota reason until a human explicitly clears the pause.
    if (!(this.state.planBlocked && this.state.lastError?.kind === 'quota' && error.kind !== 'quota')) {
      this.state.lastError = { kind: error.kind ?? 'error', message: error.message ?? String(error), detail: error.detail ?? '', code: error.code ?? null };
    }
    this.state.status = 'paused';
    this.state.planBlocked = this.state.planBlocked || ['quota', 'unavailable'].includes(error.kind);
    this.pauseRequested = true;
    this.broadcast();
    await this.persistNow();
  }

  get hasCredentials() { return Boolean(this.credentials?.access_token); }

  async credentialsForUse() {
    if (this.state.planBlocked) {
      throw Object.assign(new Error('ChatGPT plan usage is paused. Click Continue manually before another AI request.'), { kind: 'paused', pause: true });
    }
    if (!this.hasCredentials || !(this.credentials.scopes ?? []).includes('chatgpt.tokens.use.direct')) {
      const error = new Error('Sign in with ChatGPT and approve ChatGPT plan usage before starting an AI request.');
      error.kind = 'auth';
      throw error;
    }
    return this.credentials;
  }

  async saveRefreshedCredentials(updated) {
    this.credentials = updated;
    await this.vault.write('credentials.dpapi.json', updated);
    if (this.codex) { this.codex.close(); this.codex = null; }
    this.broadcast();
  }

  async refreshModels() {
    if (this.state.planBlocked) {
      const error = new Error('ChatGPT plan usage is paused after a usage limit or unavailable response. Click Continue manually before another plan request.');
      error.kind = 'paused';
      throw error;
    }
    const credentials = await this.credentialsForUse();
    try {
      this.state.models = await listAvailableModels(credentials, (updated) => this.saveRefreshedCredentials(updated));
      if (!this.state.models.some((model) => model.slug === this.state.gptModel)) this.state.gptModel = this.state.models[0]?.slug ?? '';
      if (!this.state.models.some((model) => model.slug === this.state.codexModel)) this.state.codexModel = this.state.gptModel;
      this.state.lastError = null;
      await this.persistNow();
      this.broadcast();
      return this.state.models;
    } catch (error) {
      if (error instanceof PlanRequestError) await this.setError(error);
      throw error;
    }
  }

  async testGpt({ model }) {
    await this.credentialsForUse();
    if (this.state.planBlocked) {
      const error = new Error('ChatGPT plan usage is paused after a usage limit or unavailable response. Click Continue manually before another AI request.');
      error.kind = 'paused';
      throw error;
    }
    if (this.state.status !== 'idle' || this.loopPromise || this.gptTestActive) {
      throw new Error('Run the one-request GPT check only while the development loop is idle.');
    }
    if (!model || !this.state.models.some((item) => item.slug === model)) {
      throw new Error('Choose a GPT model from the signed-in account model list.');
    }
    this.gptTestActive = true;
    this.state.gptModel = model;
    this.state.status = 'running';
    this.state.stage = `正在測試 GPT 模型：${model}`;
    this.state.lastError = null;
    this.addEvent('user', 'GPT 單次連線測試：請只回覆「Hello, world!」。', { verification: 'gpt' });
    const message = this.addEvent('gpt', '', { verification: 'gpt', streaming: true });
    await this.persistNow();
    this.broadcast();
    this.abortController = new AbortController();
    try {
      const answer = await streamResponse({
        credentials: this.credentials,
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: Hello, world!' }],
        instructions: 'This is a one-request connection check. Reply with exactly: Hello, world!',
        signal: this.abortController.signal,
        onRefresh: (updated) => this.saveRefreshedCredentials(updated),
        onDelta: async (_delta, full) => {
          message.content = full;
          this.broadcast('message');
          this.persistSoon();
        },
      });
      message.content = answer;
      message.streaming = false;
      message.partial = false;
      this.state.status = 'idle';
      this.state.stage = 'GPT single-request check completed';
      this.state.lastError = null;
      await this.persistNow();
      this.broadcast();
      return { model, answer };
    } catch (error) {
      message.streaming = false;
      message.partial = true;
      await this.setError(error);
      throw error;
    } finally {
      this.abortController = null;
      this.gptTestActive = false;
    }
  }

  async setProjectPath(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter the full path to the project folder.');
    const normalized = await realpath(normalizeProjectPathInput(value));
    const info = await stat(normalized);
    if (!info.isDirectory()) throw new Error('The selected project path is not a folder.');
    await access(normalized, constants.R_OK | constants.W_OK);
    this.state.projectPath = normalized;
    await this.persistNow();
    this.broadcast();
    return normalized;
  }

  async startTask({ text, projectPath, gptModel, codexModel, priority = 'normal' }) {
    if (!this.hasCredentials) throw new Error('Connect a ChatGPT account first.');
    if (this.gptTestActive) throw new Error('Wait for the one-request GPT check to finish before starting a development task.');
    const awaitingReview = this.getActiveTask()?.status === 'review';
    if (this.state.planBlocked) throw new Error('ChatGPT plan usage is paused. Click Continue manually before starting another AI request.');
    if (!this.state.models.length) throw new Error('Load the signed-in account model list first.');
    if (!gptModel || !this.state.models.some((model) => model.slug === gptModel)) throw new Error('Choose a model from the signed-in account model list.');
    if (!codexModel || !this.state.models.some((model) => model.slug === codexModel)) throw new Error('Choose a Codex model from the signed-in account model list.');
    const normalized = await this.setProjectPath(projectPath || this.state.projectPath);
    const task = {
      id: randomUUID(), title: text.trim().split(/\r?\n/)[0].slice(0, 120), description: text.trim(),
      priority, status: 'queued', stage: 'gpt_prompt', round: 0, createdAt: new Date().toISOString(),
      projectPath: normalized, gptModel, codexModel, prompt: '', codexReport: '', partial: '', gptHistory: [], codexThreadId: null,
    };
    if (!task.description) throw new Error('Enter a development request.');
    this.state.gptModel = gptModel;
    this.state.codexModel = codexModel;
    this.state.tasks.push(task);
    this.addEvent('user', task.description, { taskId: task.id });
    this.state.lastError = null;
    this.state.planBlocked = false;
    if (!this.state.activeTaskId) this.state.activeTaskId = task.id;
    if (awaitingReview) {
      this.state.status = 'review';
      this.state.stage = 'Waiting for human acceptance';
    } else this.state.status = 'running';
    this.pauseRequested = false;
    this.stopRequested = false;
    await this.persistNow();
    this.broadcast();
    this.ensureLoop();
    return task;
  }

  async addRequirement({ text, priority = 'high' }) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Enter the new requirement.');
    const active = this.getActiveTask();
    if (active && ['running', 'paused', 'pausing'].includes(this.state.status)) {
      const instruction = `User added a high-priority requirement while work was in progress: ${text.trim()}. Incorporate it into the current task and update the plan. If Codex is currently working, apply it to that active turn.`;
      active.gptHistory ??= [];
      active.gptHistory.push({ role: 'user', content: instruction });
      this.addEvent('user', text.trim(), { taskId: active.id, intervention: true });
      if (!this.state.planBlocked && this.codex && this.codex.activeTurnId) {
        await this.codex.steer(instruction);
      } else {
        active.pendingIntervention = true;
      }
      if (this.state.status === 'paused') active.pendingIntervention = true;
      await this.persistNow();
      this.broadcast();
      return { appliedToActive: true };
    }
    const task = {
      id: randomUUID(), title: text.trim().split(/\r?\n/)[0].slice(0, 120), description: text.trim(), priority,
      status: 'queued', stage: 'gpt_prompt', round: 0, createdAt: new Date().toISOString(),
      projectPath: this.state.projectPath, gptModel: this.state.gptModel, codexModel: this.state.codexModel, prompt: '', codexReport: '', partial: '', gptHistory: [], codexThreadId: null,
    };
    this.state.tasks.push(task);
    this.addEvent('user', task.description, { taskId: task.id });
    await this.persistNow();
    this.broadcast();
    return { appliedToActive: false, task };
  }

  async reorderTask(taskId, direction) {
    const task = this.state.tasks.find((item) => item.id === taskId);
    if (!task || task.status !== 'queued') throw new Error('Only queued tasks can be reordered.');
    const order = ['low', 'normal', 'high', 'urgent'];
    const index = order.indexOf(task.priority);
    task.priority = order[Math.max(0, Math.min(order.length - 1, index + (direction === 'up' ? 1 : -1)))];
    await this.persistNow();
    this.broadcast();
  }

  async control(action, feedback = '') {
    if (action === 'pause') {
      this.pauseRequested = true;
      this.state.status = 'pausing';
      this.state.lastError = { kind: 'paused', message: 'Pause requested. The active stream is being interrupted and partial progress is retained.' };
      this.abortController?.abort();
      if (this.codex?.activeTurnId) await this.codex.interrupt().catch(() => {});
      this.state.status = 'paused';
      await this.persistNow();
      this.broadcast();
      return;
    }
    if (action === 'stop') {
      this.stopRequested = true;
      this.pauseRequested = true;
      this.abortController?.abort();
      if (this.codex?.activeTurnId) await this.codex.interrupt().catch(() => {});
      this.state.status = 'stopped';
      this.state.lastError = { kind: 'stopped', message: 'Stopped by the user. No new AI requests will start.' };
      await this.persistNow();
      this.broadcast();
      return;
    }
    if (action === 'resume') {
      if (!this.hasCredentials) throw new Error('Sign in with ChatGPT again before resuming.');
      const active = this.getActiveTask();
      if (active?.status === 'review') throw new Error('Accept or send reviewer feedback before continuing a task awaiting human review.');
      const wasPlanBlocked = this.state.planBlocked;
      const previousError = this.state.lastError;
      if (wasPlanBlocked) {
        // A human resume is the only action that may clear the quota interlock.
        // Clear it before refreshing an empty catalog, but restore it if that
        // manually requested check fails for a non-quota reason.
        this.state.planBlocked = false;
        this.state.lastError = null;
      }
      try {
        if (!this.state.models.length) await this.refreshModels();
      } catch (error) {
        if (wasPlanBlocked && !this.state.planBlocked) {
          this.state.planBlocked = true;
          this.state.lastError = previousError;
          this.state.status = 'paused';
          this.pauseRequested = true;
          await this.persistNow();
          this.broadcast();
        }
        throw error;
      }
      this.pauseRequested = false;
      this.stopRequested = false;
      this.state.planBlocked = false;
      this.state.lastError = null;
      if (active) { active.status = 'running'; this.state.status = 'running'; }
      else if (this.state.tasks.some((item) => item.status === 'queued')) this.state.status = 'running';
      else this.state.status = 'idle';
      await this.persistNow();
      this.broadcast();
      this.ensureLoop();
      return;
    }
    if (action === 'accept') {
      const active = this.getActiveTask();
      if (!active || active.status !== 'review') throw new Error('There is no result awaiting acceptance.');
      active.status = 'accepted';
      active.acceptedAt = new Date().toISOString();
      this.addEvent('user', '使用者已人工驗收此成果。', { taskId: active.id, acceptance: true });
      this.state.activeTaskId = null;
      this.state.status = this.state.tasks.some((task) => task.status === 'queued') ? 'running' : 'idle';
      this.state.stage = '';
      await this.persistNow();
      this.broadcast();
      this.ensureLoop();
      return;
    }
    if (action === 'feedback') {
      const active = this.getActiveTask();
      if (!active || active.status !== 'review') throw new Error('There is no result awaiting review feedback.');
      if (!feedback.trim()) throw new Error('Enter review feedback.');
      active.gptHistory ??= [];
      active.gptHistory.push({ role: 'user', content: `Human review feedback: ${feedback.trim()}. Revise the work accordingly, then return a concrete next step for Codex.` });
      this.addEvent('user', feedback.trim(), { taskId: active.id, reviewFeedback: true });
      active.status = 'running';
      active.stage = 'gpt_prompt';
      active.round = 0;
      active.pendingIntervention = true;
      this.state.activeTaskId = active.id;
      this.state.status = 'running';
      this.state.lastError = null;
      await this.persistNow();
      this.broadcast();
      this.ensureLoop();
      return;
    }
    throw new Error(`Unknown task action: ${action}`);
  }

  getActiveTask() { return this.state.tasks.find((task) => task.id === this.state.activeTaskId) ?? null; }

  ensureLoop() {
    if (this.loopPromise || this.state.status !== 'running' || this.state.planBlocked) return;
    this.loopPromise = this.runLoop().catch((error) => this.setError(error)).finally(() => {
      this.loopPromise = null;
      if (this.state.status === 'running') this.ensureLoop();
    });
  }

  async runLoop() {
    while (this.state.status === 'running' && !this.state.planBlocked && !this.pauseRequested && !this.stopRequested) {
      let task = this.getActiveTask();
      if (!task) {
        const next = this.state.tasks.filter((item) => item.status === 'queued').sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.createdAt.localeCompare(b.createdAt))[0];
        if (!next) { this.state.status = 'idle'; await this.persistNow(); this.broadcast(); return; }
        task = next;
        task.status = 'running';
        this.state.activeTaskId = task.id;
      }
      this.activeTask = task;
      try {
        const done = await this.runTaskPhase(task);
        if (this.pauseRequested || this.stopRequested) break;
        if (done) return;
      } catch (error) {
        if (error.name === 'AbortError' || error.code === 'INTERRUPTED') {
          task.status = this.stopRequested ? 'stopped' : 'paused';
          this.state.status = this.stopRequested ? 'stopped' : 'paused';
          if (!this.state.lastError || !['stopped', 'paused'].includes(this.state.lastError.kind)) {
            this.state.lastError = { kind: this.stopRequested ? 'stopped' : 'paused', message: this.stopRequested ? 'Stopped by the user.' : 'Paused by the user. Partial output has been saved.' };
          }
          await this.persistNow();
          this.broadcast();
          return;
        }
        if (error.partial) {
          task.partial = error.partial;
          this.addEvent('codex', error.partial, { taskId: task.id, partial: true });
          task.stage = 'gpt_review';
        }
        task.status = 'paused';
        await this.setError(error);
        return;
      }
    }
    if (this.stopRequested) this.state.status = 'stopped';
    else if (this.pauseRequested || this.state.planBlocked) this.state.status = 'paused';
    await this.persistNow();
    this.broadcast();
  }

  async runTaskPhase(task) {
    if (task.stage === 'gpt_prompt') {
      if (task.partial) {
        task.gptHistory ??= [];
        task.gptHistory.push({ role: 'assistant', content: task.partial });
        task.gptHistory.push({ role: 'user', content: 'Your last streamed response was interrupted. Finish the required JSON result from the partial response, preserving the same task.' });
        task.partial = '';
      } else if (!task.gptInputAdded) {
        task.gptHistory ??= [];
        task.gptHistory.push({ role: 'user', content: task.description });
        task.gptInputAdded = true;
      } else if (task.pendingIntervention) {
        task.pendingIntervention = false;
        task.gptHistory ??= [];
        task.gptHistory.push({ role: 'user', content: 'Continue the current task and include the latest human intervention in the Codex instructions.' });
      }
      this.state.stage = 'GPT 正在準備 Codex 指示';
      const prompt = await this.askGpt(task, GPT_INSTRUCTIONS);
      task.prompt = prompt;
      task.stage = 'codex';
      if (!prompt.trim()) throw Object.assign(new Error('GPT returned an empty Codex prompt.'), { kind: 'empty' });
      await this.persistNow();
    }

    if (task.stage === 'codex') {
      if (task.pendingIntervention) task.prompt += `\n\nHIGH PRIORITY USER UPDATE:\n${this.state.messages.filter((item) => item.taskId === task.id && item.intervention).slice(-1)[0]?.content ?? ''}`;
      task.codexStartedAt = new Date().toISOString();
      task.codexLastActivityAt = task.codexStartedAt;
      task.codexCurrentActivity = 'Codex 已連線，正在準備工作';
      this.state.stage = `Codex 正在開發（第 ${task.round + 1} 輪）`;
      await this.persistNow();
      const result = await this.runCodex(task);
      task.codexReport = result.text;
      task.partial = '';
      task.pendingIntervention = false;
      task.round += 1;
      task.stage = 'gpt_review';
      this.addEvent('codex', result.text, { taskId: task.id, turnId: result.turnId });
      await this.persistNow();
    }

    if (task.stage === 'gpt_review') {
      if (!task.reviewInputAdded) {
        const partialPrefix = task.partial ? 'Codex was interrupted. Here is its partial report:\n' : '';
        task.gptHistory ??= [];
        task.gptHistory.push({ role: 'user', content: `Review Codex's actual report for the current task. Compare it with the original request and acceptance criteria. Do not infer unreported test success. Decide whether another concrete Codex iteration is needed, whether the human should inspect the result, or whether you are blocked.\n${partialPrefix}${task.partial || task.codexReport}` });
        task.reviewInputAdded = true;
      }
      this.state.stage = 'GPT 正在審查 Codex 回報';
      const reviewText = await this.askGpt(task, GPT_INSTRUCTIONS);
      const decision = parseDecision(reviewText);
      task.reviewInputAdded = false;
      task.partial = '';
      if (decision.action === 'continue' && decision.nextPrompt && task.round < this.state.maxRounds) {
        task.prompt = decision.nextPrompt;
        task.stage = 'codex';
        task.reviewSummary = decision.summary;
        task.codexReport = '';
        await this.persistNow();
        return false;
      }
      task.status = 'review';
      task.stage = 'awaiting_acceptance';
      task.reviewSummary = decision.summary || reviewText;
      if (task.round >= this.state.maxRounds && decision.action === 'continue') task.reviewSummary += '\n\nIteration limit reached; human review is required before continuing.';
      this.state.status = 'review';
      this.state.stage = 'Waiting for human acceptance';
      this.addEvent('gpt', `${task.reviewSummary}\n\n請檢視專案中的成果。確認後按「人工驗收」；若需修改，請提交驗收意見讓 Codex 繼續處理。`, { taskId: task.id, review: true });
      await this.persistNow();
      this.broadcast();
      return true;
    }
    return false;
  }

  async askGpt(task, instructions) {
    const credentials = await this.credentialsForUse();
    task.gptHistory ??= [];
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const message = this.addEvent('gpt', '', { taskId: task.id, streaming: true });
    let finalText = '';
    try {
      finalText = await streamResponse({
        credentials, model: task.gptModel, messages: structuredClone(task.gptHistory), instructions,
        signal,
        onRefresh: (updated) => this.saveRefreshedCredentials(updated),
        onDelta: async (delta, full) => {
          message.content = full;
          task.partial = full;
          this.broadcast('message');
          this.persistSoon();
        },
      });
      message.content = finalText;
      message.streaming = false;
      message.partial = false;
      task.partial = '';
      task.gptHistory.push({ role: 'assistant', content: finalText });
      await this.persistNow();
      this.broadcast('message');
      return finalText;
    } catch (error) {
      message.streaming = false;
      message.partial = true;
      task.partial = message.content || task.partial;
      await this.persistNow();
      if (error instanceof PlanRequestError) throw error;
      if (error.name === 'AbortError') throw error;
      throw Object.assign(error, { kind: error.kind ?? 'request' });
    } finally { this.abortController = null; }
  }

  async runCodex(task) {
    const credentials = await ensureFreshPlanToken(await this.credentialsForUse(), (updated) => this.saveRefreshedCredentials(updated));
    if (!this.codex) {
      this.codex = new CodexAppServer({ accessToken: credentials.access_token, onProgress: (event) => {
        if (event.kind === 'command') this.addEvent('activity', codexActivityText(event), { taskId: task.id });
      } });
    }
    this.abortController = new AbortController();
    let output = '';
    let lastProgressBroadcastAt = 0;
    const noteActivity = (label) => {
      task.codexLastActivityAt = new Date().toISOString();
      if (label) task.codexCurrentActivity = label;
      if (Date.now() - lastProgressBroadcastAt >= 1000) {
        lastProgressBroadcastAt = Date.now();
        this.broadcast('progress');
        this.persistSoon();
      }
    };
    try {
      const prompt = `${CODEX_PREFIX}\n\n使用者原始需求：\n${task.description}\n\nGPT 管理者給 Codex 的具體指示：\n${task.prompt}\n\n專案目錄：${task.projectPath}\n所選模型：${task.codexModel}\n\n請先檢查專案檔案，再實作需求並執行可用的相關檢查。若依賴或環境使某項檢查無法執行，請用繁體中文清楚說明。不得 commit。`;
      const savedThreadId = task.codexThreadId ?? null;
      const result = await this.codex.runTurn({
        model: task.codexModel, projectPath: task.projectPath, savedThreadId, prompt, signal: this.abortController.signal,
        onThread: (threadId) => {
          task.codexThreadId = threadId;
          noteActivity('Codex 已連線');
          this.persistSoon();
        },
        onDelta: (_delta, full) => {
          output = full;
          task.partial = full;
          noteActivity('Codex 正在產生回覆');
          this.broadcast('progress');
          this.persistSoon();
        },
        onActivity: () => noteActivity(),
        onItem: (event) => {
          const activity = codexActivityText(event);
          noteActivity(activity);
          this.addEvent('activity', activity, { taskId: task.id });
        },
      });
      task.codexThreadId = this.codex.threadId;
      return result;
    } catch (error) {
      if (error.partial || output) error.partial = error.partial || output;
      if (error.kind !== 'quota' && (error.name === 'AbortError' || this.pauseRequested || this.stopRequested)) throw Object.assign(error, { code: 'INTERRUPTED' });
      throw error;
    } finally { this.abortController = null; }
  }

  close() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.abortController?.abort();
    this.codex?.close();
  }
}

export { codexActivityText, priorityRank };
