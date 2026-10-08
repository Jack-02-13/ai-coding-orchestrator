import { filterTranscriptMessages, taskTranscriptMarkdown, transcriptMessagesForView, UNASSIGNED_TRANSCRIPT_ID } from './transcript.js';

const $ = (id) => document.getElementById(id);
let state = null;
let toastTimer;
let selectedTranscriptId = '';
let activeTranscriptTaskId = null;
let transcriptSelectionInitialized = false;
let transcriptOptionSignature = '';

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2800);
}

async function api(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Local request failed (${response.status}).`);
  return result;
}

function setSelect(select, models, selected) {
  const previous = selected || select.value;
  select.replaceChildren();
  if (!models.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '先登入並載入模型';
    select.append(option);
    select.disabled = true;
    return;
  }
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.slug;
    option.textContent = `${model.name} (${model.slug})`;
    select.append(option);
  }
  select.disabled = false;
  select.value = models.some((model) => model.slug === previous) ? previous : models[0].slug;
}

function renderTranscript(messages) {
  const transcript = $('transcript');
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
  transcript.replaceChildren();
  if (!messages?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<div class="empty-orbit"><span>G</span><i>↔</i><b>C</b></div><strong>此項目目前沒有對話紀錄</strong><p>選擇其他開發任務，或開始新的任務。</p>';
    transcript.append(empty);
    return;
  }
  for (const item of messages) {
    const article = document.createElement('article');
    article.className = `message ${item.role}${item.streaming || item.partial ? ' partial' : ''}`;
    const header = document.createElement('div');
    header.className = 'message-head';
    const name = document.createElement('strong');
    name.textContent = ({ user: item.intervention ? '你 · 新需求' : '你', gpt: item.review ? 'GPT · 審查' : 'GPT · 管理者', codex: item.streaming ? 'Codex · 即時回覆' : item.partial ? 'Codex · 暫存回覆' : 'Codex · 開發回報', activity: 'Codex · 開發紀錄', system: '系統' })[item.role] || item.role;
    const time = document.createElement('time');
    time.textContent = new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    header.append(name, time);
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = item.content || (item.streaming ? '正在產生回覆…' : '');
    article.append(header, content);
    transcript.append(article);
  }
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}

function readSavedTranscriptId() {
  try { return localStorage.getItem('ai-developer-bridge.transcript-task') ?? ''; }
  catch { return ''; }
}

function writeSavedTranscriptId(value) {
  try { localStorage.setItem('ai-developer-bridge.transcript-task', value); } catch {}
}

function transcriptStatusLabel(status) {
  return ({ queued: '待辦', running: '執行中', paused: '已暫停', stopped: '已停止', review: '待人工處理', accepted: '已驗收' })[status] ?? status ?? '未知';
}

function formatElapsed(startedAt) {
  const started = Date.parse(startedAt ?? '');
  if (!Number.isFinite(started)) return '計時中';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function inferredCodexStart(task) {
  if (task.codexStartedAt) return task.codexStartedAt;
  const history = (state?.messages ?? []).filter((item) => item.taskId === task.id);
  let lastReportIndex = -1;
  history.forEach((item, index) => { if (item.role === 'codex') lastReportIndex = index; });
  return history.slice(lastReportIndex + 1).find((item) => item.role === 'activity')?.createdAt ?? task.createdAt;
}

function summarizeActivity(item) {
  if (!item) return 'Codex 已連線，正在處理工作…';
  const content = String(item.content ?? '');
  const command = content.match(/^執行指令（([^）]+)）：([\s\S]*)$/);
  if (command) {
    const tail = command[2].trim().split(/\s(?:;|&&)\s/).at(-1) ?? command[2];
    return `最近指令：${tail.slice(-110)}（${command[1]}）`;
  }
  return content.length > 150 ? `${content.slice(0, 147)}…` : content;
}

function localizeStage(stage) {
  const codex = stage?.match(/^Codex is working \(iteration (\d+)\)$/);
  if (codex) return `Codex 正在開發（第 ${codex[1]} 輪）`;
  if (stage === 'GPT is preparing Codex instructions') return 'GPT 正在準備 Codex 指示';
  if (stage === 'GPT is reviewing Codex’s report') return 'GPT 正在審查 Codex 回報';
  if (stage === 'Waiting for human acceptance') return '等待人工驗收';
  if (stage === 'GPT single-request check completed') return 'GPT 單次連線測試已完成';
  const test = stage?.match(/^Testing GPT model (.+)$/);
  if (test) return `正在測試 GPT 模型：${test[1]}`;
  return stage;
}

function renderLiveStatus() {
  const task = state?.tasks?.find((item) => item.id === state.activeTaskId);
  const active = state?.status === 'running' && task?.stage === 'codex';
  const banner = $('live-status');
  banner.classList.toggle('hidden', !active);
  if (!active) return;
  const activity = task.codexCurrentActivity
    ? { content: task.codexCurrentActivity }
    : [...(state.messages ?? [])].reverse().find((item) => item.taskId === task.id && item.role === 'activity');
  $('live-status-title').textContent = `Codex 正在執行第 ${Math.max(1, (task.round ?? 0) + 1)} 輪`;
  $('live-status-detail').textContent = summarizeActivity(activity);
  $('live-status-elapsed').textContent = `已執行 ${formatElapsed(inferredCodexStart(task))}`;
}

function updateTranscriptView() {
  const messages = transcriptMessagesForView({
    messages: state?.messages ?? [], tasks: state?.tasks ?? [], transcriptId: selectedTranscriptId,
    activeTaskId: state?.activeTaskId, status: state?.status,
  });
  $('message-count').textContent = `${messages.length} 則紀錄`;
  $('save-transcript').disabled = messages.length === 0;
  renderTranscript(messages);
}

function syncTranscriptSelector(tasks, messages, activeTaskId) {
  const select = $('transcript-task');
  const includesUnassigned = messages.some((item) => !item.taskId);
  if (!transcriptSelectionInitialized) {
    const saved = readSavedTranscriptId();
    const knownTask = tasks.some((task) => task.id === saved);
    selectedTranscriptId = knownTask || (saved === UNASSIGNED_TRANSCRIPT_ID && includesUnassigned)
      ? saved
      : activeTaskId || tasks.at(-1)?.id || UNASSIGNED_TRANSCRIPT_ID;
    transcriptSelectionInitialized = true;
  } else if (activeTaskId && activeTaskId !== activeTranscriptTaskId && (!selectedTranscriptId || selectedTranscriptId === activeTranscriptTaskId)) {
    selectedTranscriptId = activeTaskId;
  }
  if (activeTaskId) activeTranscriptTaskId = activeTaskId;
  const signature = JSON.stringify({
    tasks: tasks.map(({ id, title, status }) => [id, title, status]),
    includesUnassigned,
  });
  if (signature !== transcriptOptionSignature) {
    select.replaceChildren();
    if (includesUnassigned) {
      const option = document.createElement('option');
      option.value = UNASSIGNED_TRANSCRIPT_ID;
      option.textContent = '一般紀錄（未綁定任務）';
      select.append(option);
    }
    for (const task of [...tasks].reverse()) {
      const option = document.createElement('option');
      option.value = task.id;
      const date = task.createdAt ? new Date(task.createdAt).toLocaleDateString('zh-TW') : '';
      option.textContent = `${date ? `${date} · ` : ''}${task.title} · ${transcriptStatusLabel(task.status)}`;
      option.title = task.description ?? task.title;
      select.append(option);
    }
    transcriptOptionSignature = signature;
  }
  const isValid = tasks.some((task) => task.id === selectedTranscriptId)
    || (selectedTranscriptId === UNASSIGNED_TRANSCRIPT_ID && includesUnassigned);
  if (!isValid) selectedTranscriptId = activeTaskId || tasks.at(-1)?.id || UNASSIGNED_TRANSCRIPT_ID;
  if (select.value !== selectedTranscriptId) select.value = selectedTranscriptId;
  writeSavedTranscriptId(selectedTranscriptId);
}

function saveCurrentTranscript() {
  const messages = filterTranscriptMessages(state?.messages ?? [], selectedTranscriptId);
  if (!messages.length) return;
  const task = state.tasks?.find((item) => item.id === selectedTranscriptId) ?? {
    id: 'unassigned', title: '一般紀錄', description: '未綁定開發任務的對話紀錄', status: 'saved', priority: 'normal',
  };
  const markdown = taskTranscriptMarkdown(task, messages);
  const safeTitle = String(task.title || '開發紀錄').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-').slice(0, 70) || '開發紀錄';
  const date = new Date().toISOString().replace('T', '-').replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob(['\uFEFF', markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `AI-Developer-${safeTitle}-${date}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已下載此任務的繁體中文開發紀錄。');
}

function renderTasks(tasks = []) {
  const queued = tasks.filter((item) => item.status === 'queued').sort((a, b) => ({ urgent: 4, high: 3, normal: 2, low: 1 }[b.priority] ?? 2) - ({ urgent: 4, high: 3, normal: 2, low: 1 }[a.priority] ?? 2));
  $('queue-count').textContent = String(queued.length);
  const list = $('task-list');
  list.replaceChildren();
  list.classList.toggle('empty', queued.length === 0);
  if (!queued.length) { list.textContent = '尚無待辦'; return; }
  for (const task of queued) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    const title = document.createElement('strong');
    title.textContent = task.title;
    const priority = document.createElement('small');
    priority.textContent = `優先：${({ urgent: '最高', high: '高', normal: '一般', low: '低' })[task.priority] ?? '一般'}`;
    const actions = document.createElement('div');
    actions.className = 'queue-actions';
    for (const [direction, symbol, label] of [['up', '↑', '提高優先順序'], ['down', '↓', '降低優先順序']]) {
      const button = document.createElement('button');
      button.textContent = symbol;
      button.title = label;
      button.addEventListener('click', async () => {
        try { await api(`/api/tasks/${encodeURIComponent(task.id)}/priority`, { direction }); }
        catch (error) { toast(error.message); }
      });
      actions.append(button);
    }
    row.append(title, actions, priority);
    list.append(row);
  }
}

function render(next) {
  if (!next) return;
  state = next;
  const connected = Boolean(state.auth?.connected && state.auth?.planUsageEnabled);
  $('connection-badge').textContent = connected ? (state.auth.email || 'ChatGPT 已授權') : '尚未連線';
  $('connection-badge').className = `badge ${connected ? 'connected' : 'muted'}`;
  $('auth-button').classList.toggle('hidden', connected);
  $('signout-button').classList.toggle('hidden', !connected);
  $('auth-button').disabled = !state;
  $('auth-detail').textContent = connected
    ? `${state.auth.email || 'ChatGPT 帳號'} · 訂閱用量授權已驗證`
    : state.authMessage || '使用 Sign in with ChatGPT。此工作台不接受 API Key。';
  const active = state.tasks?.find((task) => task.id === state.activeTaskId);
  const awaitingReview = active?.status === 'review';
  $('models-button').disabled = !connected || ['running', 'pausing'].includes(state.status) || Boolean(state.planBlocked);
  $('gpt-test-button').disabled = !connected || !state.models?.length || state.status !== 'idle' || Boolean(state.planBlocked);
  $('start-button').disabled = !connected || !state.models?.length || ['running', 'pausing'].includes(state.status) || Boolean(state.planBlocked);
  $('start-label').textContent = awaitingReview ? '加入佇列（驗收後開始）' : '開始 GPT → Codex 流程';
  $('start-button').title = awaitingReview ? '此需求會排隊，驗收目前結果後才開始執行。' : '';
  $('composer-hint').textContent = awaitingReview
    ? '目前任務等待人工驗收；此需求會先排隊，驗收後才開始，不會提前送出 AI 請求。'
    : 'GPT/Codex 都會使用此 ChatGPT 帳號的訂閱用量';
  $('pause-button').disabled = !['running', 'pausing'].includes(state.status);
  $('resume-button').disabled = !['paused', 'stopped'].includes(state.status);
  $('stop-button').disabled = !['running', 'pausing', 'paused'].includes(state.status);
  const awaiting = active?.status === 'review';
  $('accept-button').disabled = !awaiting;
  $('feedback-button').disabled = !awaiting;
  $('requirement-button').disabled = !active || !['running', 'paused', 'pausing'].includes(state.status);
  document.querySelector('.pulse-dot').classList.toggle('live', ['running', 'pausing'].includes(state.status));
  $('status-detail').textContent = localizeStage(state.stage) || ({ idle: '準備就緒', running: '工作進行中', pausing: '正在暫停…', paused: '已暫停', stopped: '已停止', review: '等待人工驗收' })[state.status] || state.status;
  if (state.projectPath && document.activeElement !== $('project-path')) $('project-path').value = state.projectPath;
  setSelect($('gpt-model'), state.models ?? [], state.gptModel);
  setSelect($('codex-model'), state.models ?? [], state.codexModel);
  $('message-count').textContent = `${state.messages?.length ?? 0} 則紀錄`;
  $('storage-location').textContent = state.storageLocation || '';
  renderTasks(state.tasks ?? []);
  syncTranscriptSelector(state.tasks ?? [], state.messages ?? [], state.activeTaskId);
  updateTranscriptView();
  renderLiveStatus();
  const error = state.lastError;
  $('error-banner').classList.toggle('hidden', !error || error.kind === 'paused');
  if (error && error.kind !== 'paused') {
    $('error-title').textContent = error.kind === 'quota' ? 'ChatGPT 訂閱用量已暫停' : error.kind === 'ineligible' ? '此帳號目前不符合使用資格' : '流程已暫停';
    $('error-message').textContent = error.message;
    $('error-detail').textContent = error.detail || (error.code ? `code=${error.code}` : '進度已保存；不會切換到 API Key 或按量計費服務。');
  }
}

$('transcript-task').addEventListener('change', () => {
  selectedTranscriptId = $('transcript-task').value;
  writeSavedTranscriptId(selectedTranscriptId);
  updateTranscriptView();
});
$('save-transcript').addEventListener('click', saveCurrentTranscript);

async function runAction(action, feedback = '') {
  try { await api('/api/control', { action, feedback }); }
  catch (error) { toast(error.message); }
}

$('auth-button').addEventListener('click', async () => {
  const popup = window.open('about:blank', '_blank');
  try {
    const result = await api('/api/auth/start', {});
    if (popup) popup.location = result.authorizeUrl;
    else window.location.assign(result.authorizeUrl);
  } catch (error) { popup?.close(); toast(error.message); }
});
$('signout-button').addEventListener('click', async () => {
  if (!window.confirm('從 AI Developer Bridge 清除這個 ChatGPT OAuth 授權？')) return;
  try { await api('/api/auth/signout', {}); toast('ChatGPT 已登出。'); } catch (error) { toast(error.message); }
});
$('models-button').addEventListener('click', async () => {
  $('models-button').disabled = true;
  $('models-button').textContent = '正在讀取…';
  try {
    await api('/api/models/refresh', {});
    toast('已載入此帳號可用模型。');
  } catch (error) { toast(error.message); }
  finally { $('models-button').textContent = '重新載入帳號模型'; if (state) $('models-button').disabled = !state.auth?.connected || Boolean(state.planBlocked); }
});
$('gpt-test-button').addEventListener('click', async () => {
  $('gpt-test-button').disabled = true;
  $('gpt-test-button').textContent = 'GPT 測試中…';
  try {
    const result = await api('/api/gpt-test', { model: $('gpt-model').value });
    toast(`GPT 已回覆：${result.answer}`);
  } catch (error) { toast(error.message); }
  finally { $('gpt-test-button').textContent = '測試 GPT 單次回應'; if (state) $('gpt-test-button').disabled = !state.auth?.connected || !state.models?.length || state.status !== 'idle' || Boolean(state.planBlocked); }
});
$('save-path').addEventListener('click', async () => {
  try { const result = await api('/api/project', { projectPath: $('project-path').value }); $('project-path').value = result.projectPath; toast('專案路徑已保存。'); }
  catch (error) { toast(error.message); }
});
$('start-button').addEventListener('click', async () => {
  const text = $('task-input').value.trim();
  if (!text) return toast('請先描述開發任務。');
  const queueBehindReview = state?.tasks?.some((task) => task.id === state.activeTaskId && task.status === 'review');
  $('start-button').disabled = true;
  try {
    await api('/api/tasks', { text, projectPath: $('project-path').value, gptModel: $('gpt-model').value, codexModel: $('codex-model').value, priority: $('task-priority').value });
    $('task-input').value = '';
    toast(queueBehindReview ? '已加入佇列；驗收目前結果後會開始。' : '已開始 GPT 規劃與 Codex 開發。');
  } catch (error) { toast(error.message); }
  finally { if (state) $('start-button').disabled = !state.auth?.connected || !state.models?.length || ['running', 'pausing'].includes(state.status) || Boolean(state.planBlocked); }
});
$('requirement-button').addEventListener('click', async () => {
  const text = $('requirement-input').value.trim();
  if (!text) return toast('請輸入新需求。');
  try { await api('/api/requirements', { text }); $('requirement-input').value = ''; toast('新需求已送給目前任務。'); }
  catch (error) { toast(error.message); }
});
$('requirement-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('requirement-button').click(); });
$('pause-button').addEventListener('click', () => runAction('pause'));
$('resume-button').addEventListener('click', () => runAction('resume'));
$('stop-button').addEventListener('click', () => runAction('stop'));
$('accept-button').addEventListener('click', () => runAction('accept'));
$('feedback-button').addEventListener('click', () => {
  const text = $('review-feedback').value.trim();
  if (!text) return toast('請先輸入驗收意見。');
  runAction('feedback', text).then(() => { $('review-feedback').value = ''; });
});
$('gpt-model').addEventListener('change', () => { if (state) state.gptModel = $('gpt-model').value; });
$('codex-model').addEventListener('change', () => { if (state) state.codexModel = $('codex-model').value; });

const events = new EventSource('/api/events');
events.addEventListener('state', (event) => { try { render(JSON.parse(event.data)); } catch {} });
events.addEventListener('message', (event) => { try { render(JSON.parse(event.data)); } catch {} });
events.addEventListener('progress', (event) => { try { render(JSON.parse(event.data)); } catch {} });
events.onerror = () => $('connection-badge').className = 'badge muted';
api('/api/state').then(render).catch((error) => toast(error.message));
setInterval(renderLiveStatus, 1000);
