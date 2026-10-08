export const UNASSIGNED_TRANSCRIPT_ID = '__unassigned__';

export function filterTranscriptMessages(messages, transcriptId) {
  if (transcriptId === UNASSIGNED_TRANSCRIPT_ID) return messages.filter((item) => !item.taskId);
  return messages.filter((item) => item.taskId === transcriptId);
}

export function transcriptMessagesForView({ messages = [], tasks = [], transcriptId, activeTaskId, status, now = new Date().toISOString() }) {
  const visible = filterTranscriptMessages(messages, transcriptId);
  const activeTask = tasks.find((task) => task.id === transcriptId && task.id === activeTaskId);
  if (activeTask?.stage === 'codex' && activeTask.partial) {
    visible.push({
      id: `live-codex-${activeTask.id}`,
      taskId: activeTask.id,
      role: 'codex',
      content: activeTask.partial,
      createdAt: now,
      streaming: status === 'running',
      partial: status !== 'running',
    });
  }
  return visible;
}

export function taskTranscriptMarkdown(task, messages) {
  const statusLabels = {
    queued: '待辦', running: '執行中', paused: '已暫停', stopped: '已停止',
    review: '等待人工處理', accepted: '已驗收',
  };
  const priorityLabels = { urgent: '最高', high: '高', normal: '一般', low: '低' };
  const lines = [
    `# ${task.title || '開發任務'}`,
    '',
    `- 任務 ID：${task.id}`,
    `- 狀態：${statusLabels[task.status] ?? task.status ?? '未知'}`,
    `- 優先順序：${priorityLabels[task.priority] ?? task.priority ?? '一般'}`,
    `- 建立時間：${task.createdAt ?? '未知'}`,
    `- 專案路徑：${task.projectPath ?? '未知'}`,
    `- GPT 模型：${task.gptModel ?? '未知'}`,
    `- Codex 模型：${task.codexModel ?? '未知'}`,
    '',
    '## 原始需求',
    '',
    task.description || '（無）',
    '',
    '## 對話與開發紀錄',
    '',
  ];
  const roleLabels = { user: '使用者', gpt: 'GPT', codex: 'Codex', activity: 'Codex 開發活動', system: '系統' };
  for (const item of messages) {
    lines.push(`### ${roleLabels[item.role] ?? item.role} · ${item.createdAt ?? '時間未知'}`, '', item.content || '（空白訊息）', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
