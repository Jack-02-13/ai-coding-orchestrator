import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTranscriptMessages, taskTranscriptMarkdown, transcriptMessagesForView, UNASSIGNED_TRANSCRIPT_ID } from '../public/transcript.js';
import { codexActivityText, Orchestrator } from '../src/orchestrator.mjs';

const messages = [
  { taskId: 'task-a', role: 'user', content: '第一項需求', createdAt: '2026-10-08T08:00:00.000Z' },
  { taskId: 'task-b', role: 'codex', content: '第二項回報', createdAt: '2026-10-08T08:01:00.000Z' },
  { role: 'gpt', content: '一般連線測試', createdAt: '2026-10-08T08:02:00.000Z' },
];

test('transcript filtering keeps each development task separate', () => {
  assert.deepEqual(filterTranscriptMessages(messages, 'task-a').map((item) => item.content), ['第一項需求']);
  assert.deepEqual(filterTranscriptMessages(messages, 'task-b').map((item) => item.content), ['第二項回報']);
  assert.deepEqual(filterTranscriptMessages(messages, UNASSIGNED_TRANSCRIPT_ID).map((item) => item.content), ['一般連線測試']);
});

test('active Codex partial output appears only in its selected task transcript', () => {
  const tasks = [{ id: 'task-a', stage: 'codex', partial: '正在修改表單', status: 'running' }];
  const live = transcriptMessagesForView({ messages, tasks, transcriptId: 'task-a', activeTaskId: 'task-a', status: 'running', now: '2026-10-08T08:03:00.000Z' });
  const other = transcriptMessagesForView({ messages, tasks, transcriptId: 'task-b', activeTaskId: 'task-a', status: 'running', now: '2026-10-08T08:03:00.000Z' });

  assert.equal(live.at(-1).content, '正在修改表單');
  assert.equal(live.at(-1).streaming, true);
  assert.deepEqual(other.map((item) => item.content), ['第二項回報']);
});

test('failed command activity includes its timeout and exit diagnostics', () => {
  const activity = codexActivityText({
    kind: 'command', text: 'npm run test:browser', status: 'failed', exitCode: 124, durationMs: 300_000,
    failureOutput: 'browser startup\nError: command timed out after 300000ms\nBearer test-redaction',
  });
  assert.match(activity, /執行指令（失敗）：npm run test:browser/);
  assert.match(activity, /退出碼：124/);
  assert.match(activity, /300\.0 秒/);
  assert.match(activity, /timed out after 300000ms/);
  assert.doesNotMatch(activity, /test-redaction/);
});

test('downloadable task transcript contains task metadata and the complete selected conversation', () => {
  const task = {
    id: 'task-a', title: '第一項任務', description: '完成指定功能', status: 'accepted', priority: 'high',
    createdAt: '2026-10-08T07:59:00.000Z', projectPath: 'C:\\workspace\\demo', gptModel: 'gpt-model', codexModel: 'codex-model',
  };
  const scopedMessages = filterTranscriptMessages(messages, task.id);
  const markdown = taskTranscriptMarkdown(task, scopedMessages);

  assert.match(markdown, /# 第一項任務/);
  assert.match(markdown, /- 狀態：已驗收/);
  assert.match(markdown, /## 原始需求[\s\S]*完成指定功能/);
  assert.match(markdown, /使用者 · 2026-10-08T08:00:00\.000Z[\s\S]*第一項需求/);
  assert.doesNotMatch(markdown, /第二項回報|一般連線測試/);
});

test('legacy shared GPT context and Codex thread are migrated only to the active task', async (t) => {
  const app = new Orchestrator();
  const previousState = {
    activeTaskId: 'active',
    tasks: [
      { id: 'active', projectPath: 'C:\\workspace\\demo' },
      { id: 'other', projectPath: 'C:\\workspace\\demo' },
    ],
    gptHistory: [{ role: 'assistant', content: '既有回覆' }],
    codexThreads: { 'C:\\workspace\\demo': 'legacy-thread' },
  };
  t.mock.method(app.vault, 'init', async () => {});
  t.mock.method(app.vault, 'read', async (name) => name === 'state.dpapi.json' ? previousState : null);
  t.mock.method(app.vault, 'write', async () => {});
  t.after(() => app.close());

  await app.init();

  assert.deepEqual(app.state.tasks[0].gptHistory, previousState.gptHistory);
  assert.equal(app.state.tasks[0].codexThreadId, 'legacy-thread');
  assert.deepEqual(app.state.tasks[1].gptHistory, []);
  assert.equal(app.state.tasks[1].codexThreadId, undefined);
  assert.deepEqual(app.state.gptHistory, []);
  assert.deepEqual(app.state.codexThreads, {});
});
