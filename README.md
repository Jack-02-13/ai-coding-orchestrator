# AI Developer Bridge

[English](README.md) | [繁體中文](README.zh-TW.md)

AI Developer Bridge is a **local Windows dashboard** for a user-directed GPT ↔ Codex development loop. GPT turns your request into implementation instructions and reviews Codex's report. Codex uses the official Codex app-server to edit files and run available checks in the project folder you select. You can add requirements, pause the workflow, and review the result at any time.

> This is a local web app, not a site hosted on GitHub Pages. It runs at `http://127.0.0.1:1455` on your own computer so Codex can work with your local project.

## Before you begin: step-by-step setup

Complete these steps before starting the dashboard:

1. **Install Node.js 20 or later.** Download it from [nodejs.org](https://nodejs.org/), then open PowerShell and verify both commands:

   ```powershell
   node --version
   npm --version
   ```

   `node --version` should report `v20` or newer. Node.js is needed to run the local server and install its package.

2. **Install OpenAI Codex CLI.** Follow the [official Codex CLI installation guide](https://developers.openai.com/codex/cli/), then verify it in PowerShell:

   ```powershell
   codex --version
   ```

   The command must print a version. You do not need to sign in to Codex CLI separately; this app passes its authorized ChatGPT OAuth token to Codex app-server.

3. **Download the project.** On this GitHub page, select **Code → Download ZIP** and extract it to a folder where you have write access.

4. **Start the dashboard.** Double-click `Start-AI-Developer.bat` in the extracted project folder. The first launch installs the required open-source package from npm, so an internet connection is needed. The browser should open `http://127.0.0.1:1455`; keep the startup window open while using the app. Press `Ctrl+C` in that window to stop the local server.

Port `1455` must be available. If the browser does not open automatically, visit `http://127.0.0.1:1455` manually. If the page does not load, check the startup window and make sure the port is not already in use.

## First-time setup in the dashboard

1. Click **Continue with ChatGPT** in the dashboard.
2. On the official OpenAI sign-in page, choose your account, review the consent screen, and authorize ChatGPT plan usage. You will be returned to the local dashboard after sign-in.
3. Under **開發目錄** (Project folder), enter the full path to the project Codex should edit, then click **設定** (Set). For example:

   ```text
   C:\Projects\my-project
   ```

   Enter the path without surrounding quotes and make sure the folder exists and is the project you intend to modify.

4. Click **載入帳號模型** (Load account models). Choose a **GPT 管理者模型** (GPT manager model) and a **Codex 開發模型** (Codex development model) from the models returned for your account.
5. Optionally click **測試 GPT 單次回應** (Test one GPT response) to check the GPT connection. This sends one real model request and uses your account's ChatGPT plan usage.

Sign-in uses the official Sign in with ChatGPT OAuth flow and PKCE. The app proceeds only when the approved authorization includes the ChatGPT plan usage permission. If the account or workspace does not receive the `chatgpt.tokens.use.direct` scope, the app stops and reports the reason; it does not switch to an API key or another paid route. See [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

## Create and run a task

1. In **建立開發任務** (New development task), describe the feature, constraints, and acceptance criteria.
2. Choose a priority: **一般** (Normal), **高** (High), **最高** (Urgent), or **低** (Low).
3. Click **開始 GPT → Codex 流程** (Start GPT → Codex).
4. Watch **對話與開發紀錄** (Conversation and development log) for GPT's plan, Codex activity and report, and GPT's review. When Codex is busy, the dashboard shows its running state and progress events.
5. If GPT determines that more changes are needed, it sends another instruction to Codex. The workflow pauses when it is ready for review or needs a human decision.
6. Inspect the actual file changes and report. Click **人工驗收** (Accept) to finish, or enter **驗收意見** (review feedback) and click **提交驗收意見並繼續** (Submit feedback and continue) for another iteration.

Codex can write to the selected project workspace and run commands or checks. Network access is disabled for the command sandbox. Before starting, create a Git commit or backup. Review the changes yourself before accepting the result.

## Human intervention and controls

- **插入新需求** (Add a requirement): Enter a follow-up and click **插入** (Add). It is sent to the active task when one is running; otherwise, it becomes a queued task.
- **暫停** (Pause): Interrupts the current AI turn and keeps partial progress. You can edit project files by hand, add a requirement, and then click **繼續** (Continue).
- **繼續** (Continue): Resumes paused work or starts queued work. If a task is waiting for human review, accept it or submit feedback first.
- **停止** (Stop): Stops the current workflow and prevents new AI requests from starting.
- **Reorder queued tasks**: Use the controls next to a queued task to change its priority.
- **View or save an old transcript**: Select a task in the transcript menu. Click **下載此紀錄** (Download this transcript) to save that task's conversation log.

When GPT or Codex needs a human decision or cannot proceed, the workflow pauses and explains why in the dashboard. Add information, edit the project, resume, or stop the task.

## Usage and billing

- GPT and Codex use the signed-in account's ChatGPT plan authorization and usage. They do not have separate Plus allowances.
- This app has no API-key setting and no fallback to a pay-as-you-go API. **Model requests use ChatGPT plan usage** and are subject to the account's limits and OpenAI's current service rules.
- When a plan usage limit or service availability error is detected, the app saves its state and pauses new AI requests. It does not retry indefinitely or guess when usage will reset.
- After you confirm that usage is available again, click **繼續** (Continue) yourself. If the limit still applies, the request will pause again. Check [ChatGPT usage settings](https://chatgpt.com/settings/usage).
- If OAuth permission is missing, the account is ineligible, a model is unavailable, or authorization expires, follow the dashboard message or sign in again. The app will not ask for an API key as a workaround.

## Conversation data and security

- OAuth credentials, task state, transcripts, the task queue, and Codex thread IDs are stored in `%LOCALAPPDATA%\AI-Developer-Bridge`, outside the source folder. On Windows, credentials and saved state are encrypted with DPAPI for the current Windows account.
- GPT needs task history to plan and review, so each request sends the relevant conversation history to OpenAI. Do not include passwords, API keys, private keys, or other secrets you should not send to a model.
- Responses API requests use `store: false` and `stream: true`; the app maintains its own conversation history. See [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
- The local dashboard listens only on `127.0.0.1`. Do not expose it to the public internet or upload OAuth tokens or private transcripts to GitHub.
- Codex can edit and run commands in the project you select. Verify the project path and review all changes before accepting.

## Troubleshooting

### Node.js is not found at startup

Install Node.js 20 or later, reopen PowerShell or Command Prompt, and confirm that `node --version` prints a version before launching the batch file again.

### The app cannot find Codex CLI

Install Codex using the [official Codex CLI instructions](https://developers.openai.com/codex/cli/), confirm that `codex --version` works, and restart `Start-AI-Developer.bat`.

### Sign-in succeeds, but models do not load or tasks cannot start

Check which ChatGPT account you authorized and whether you approved ChatGPT plan usage. Some accounts, workspaces, regions, or models may not be supported. Read the error shown in the dashboard; do not repeatedly authorize or use an API key to bypass an eligibility error.

### Codex reports an error or the task stops

Read the error banner and the Codex activity in that task's transcript. Check that the project path exists, Codex CLI is available, the selected model supports the request, and your plan usage is available. You can manually resume after a temporary service error; usage-limit errors are not retried automatically.

### The browser cannot connect or does not return after sign-in

Keep the batch-file window open and visit `http://127.0.0.1:1455` manually. Check that local port `1455` is available and that your browser can return to the `127.0.0.1` OAuth callback.

## Want to modify AI Developer Bridge itself?

This section is for contributors who want to change this tool's source code. Regular users can skip these commands and follow [Before you begin: step-by-step setup](#before-you-begin-step-by-step-setup) instead.

```powershell
npm install
npm test
npm start
```

After starting, visit `http://127.0.0.1:1455`. `npm test` runs local automated tests; it does not verify every user's OAuth eligibility or plan usage.

## Official documentation

- [Sign in with ChatGPT: Open-source apps and ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Codex CLI](https://developers.openai.com/codex/cli/)

## License

This project is licensed under the [MIT License](LICENSE). Use of Sign in with ChatGPT and ChatGPT plan usage remains subject to current OpenAI eligibility, policies, and product terms. Publishing the source code does not guarantee that every account can use this capability.
