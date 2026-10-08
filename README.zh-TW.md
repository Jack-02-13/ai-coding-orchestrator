# AI Developer Bridge

[English](README.md) | [繁體中文](README.zh-TW.md)

AI Developer Bridge 是一個在 **Windows 本機執行**的開發工作台：GPT 負責整理需求、產生 Codex 指示並審查結果；Codex 透過官方 Codex app-server 在你選定的專案目錄修改程式、執行可用檢查，再把結果交回 GPT。你可以隨時插入需求、暫停流程或人工驗收。

> 這是本機網頁工作台，不是部署在 GitHub Pages 的網站。程式會在自己的電腦開啟 `http://127.0.0.1:1455`，才能讓 Codex 存取本機專案。

## 使用前準備：一步一步設定

請依序完成以下步驟，再啟動工作台：

1. **安裝 Node.js 20 或更新版本。** 到 [nodejs.org](https://nodejs.org/) 下載並安裝，接著開啟 PowerShell，執行以下指令確認安裝成功：

   ```powershell
   node --version
   npm --version
   ```

   `node --version` 應顯示 `v20` 或更新版本。工作台需要 Node.js 執行本機服務及安裝套件。

2. **安裝 OpenAI Codex CLI。** 依照 [Codex CLI 官方安裝說明](https://developers.openai.com/codex/cli/)安裝，再於 PowerShell 執行：

   ```powershell
   codex --version
   ```

   指令必須能顯示版本號。你不需要另外登入 Codex CLI；工作台會把已授權的 ChatGPT OAuth token 提供給 Codex app-server 使用，不需要 API Key。[Codex app-server 官方文件](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

3. **下載並解壓縮專案。** 在 GitHub 專案頁面選 **Code → Download ZIP**，解壓縮到你有寫入權限的資料夾。

4. **啟動工作台。** 在解壓縮後的專案資料夾雙擊 `Start-AI-Developer.bat`。第一次啟動時，批次檔會從 npm 安裝專案需要的開源套件，因此需要網路連線。瀏覽器應開啟 `http://127.0.0.1:1455`；使用期間請保持啟動視窗開啟。在該視窗按 `Ctrl+C` 可停止本機服務。

本機連接埠 `1455` 必須可用。如果瀏覽器沒有自動開啟，請手動前往 `http://127.0.0.1:1455`。如果頁面無法載入，請查看啟動視窗中的錯誤，並確認沒有其他程式占用此連接埠。

## 第一次設定

1. 在工作台按 **Continue with ChatGPT**。
2. 在 OpenAI 官方登入頁選擇帳號，檢查授權畫面後同意使用 ChatGPT 方案用量。登入成功後會回到本機工作台。
3. 在 **開發目錄**輸入要讓 Codex 修改的專案完整路徑，按 **設定**。例如：

   ```text
   C:\Projects\my-project
   ```

   請輸入未加引號的路徑，並確認資料夾存在且是你想修改的專案。

4. 按 **載入帳號模型**，從帳號回傳的可用模型清單選擇 **GPT 管理者模型** 和 **Codex 開發模型**。
5. 可先按 **測試 GPT 單次回應**確認 GPT 連線。這會送出一次真實模型請求並使用帳號方案用量。

官方登入採用 Sign in with ChatGPT OAuth 與 PKCE。程式只會在授權後使用已核准的 ChatGPT 方案權限；若帳號或工作區沒有取得 `chatgpt.tokens.use.direct` 權限，工作台會停止並顯示原因，不會改用 API Key 或其他付費路徑。[註冊與登入說明](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

## 建立與執行開發任務

1. 在 **建立開發任務**輸入要完成的功能、不能變動的部分，以及你如何判定完成。描述越具體，GPT 越容易產生可執行的 Codex 指示。
2. 選擇優先順序：一般、高、最高或低。
3. 按 **開始 GPT → Codex 流程**。
4. 工作台會在 **對話與開發紀錄**顯示 GPT 的規劃、Codex 的執行活動與回報，以及 GPT 的審查結果。Codex 執行時間較長時，可查看「執行中」狀態與進度訊息。
5. GPT 判定需要更多修改時，會產生下一輪指示交給 Codex；完成或需要人工判斷時，任務會停下等待你處理。
6. 檢查實際檔案變更及回報後，按 **人工驗收**結束任務；若要修改，輸入 **驗收意見**並按 **提交驗收意見並繼續**。

Codex 會在你指定的專案工作區寫入，並可執行程式及相關檢查。執行命令的沙盒不提供網路存取。開始前建議先用 Git 建立提交或備份；Codex 可能修改或新增專案檔案，請在人工驗收前自行檢查差異。

## 人工介入與流程控制

- **插入新需求**：輸入補充條件並按 **插入**。若有進行中的任務，需求會加入該任務；否則會建立待辦任務。
- **暫停**：停止目前的 AI 回合並保留已收到的部分進度。你可手動修改專案檔案，再補充需求並按 **繼續**。
- **繼續**：繼續暫停中的工作或開始待辦。若任務正在等待人工驗收，請先驗收或提交修改意見。
- **停止**：停止目前流程，不會再開始新的 AI 請求。
- **調整待辦順序**：使用待辦項目旁的順序控制調整優先級。
- **查看舊紀錄**：在對話紀錄的選單選擇任務；按 **下載此紀錄**可另存該任務的紀錄檔。

需要人工決定或遇到無法自行解決的問題時，流程會暫停並在工作台顯示原因。你可以插入說明、修改專案後繼續，或停止任務。

## 用量與費用

- GPT 與 Codex 都使用登入者的 ChatGPT 方案授權與用量；它們不會因此取得各自獨立的 Plus 額度。
- 本程式沒有 API Key 設定，也沒有切換到按量計費 API 的後備路徑。**模型請求會使用 ChatGPT 方案用量**；使用量上限依 OpenAI 帳號與服務規則而定。
- 偵測到方案用量限制或服務不可用時，工作台會保存狀態並暫停新的 AI 請求，不會無限重試或自行推測恢復時間。
- 確認帳號已恢復可用後，再由你按 **繼續**。若仍未恢復，請求會再次暫停。可到 [ChatGPT 用量設定](https://chatgpt.com/settings/usage)查看帳號狀態。
- 若官方 OAuth 沒有授權、帳號不符合資格、模型不可用或授權失效，請依畫面提示處理或重新登入；程式不會要求 API Key 作為替代方案。

## 對話資料與安全

- OAuth 憑證、任務狀態、對話紀錄、排程及 Codex thread ID 存放在 `%LOCALAPPDATA%\AI-Developer-Bridge`，不存放於專案來源目錄。Windows 上的憑證與狀態使用目前 Windows 帳號的 DPAPI 加密。
- 因為 GPT 需要規劃與審查，每次請求會把該任務所需的對話歷史送至 OpenAI。請勿提交密碼、API Key、私鑰或不應傳送給模型的機密資料。
- Responses API 請求設定 `store: false` 與 `stream: true`，並由應用程式自行保留對話歷史。[模型與推論官方文件](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- 本機控制台只綁定 `127.0.0.1`。不要把它改成可從公用網路存取的服務，也不要將授權 token 或個人對話紀錄上傳到 GitHub。
- Codex 會依你的要求讀寫選定專案並執行命令。執行前請檢查專案路徑，並在驗收前審閱變更。

## 常見問題

### 啟動時說找不到 Node.js

安裝 Node.js 20 或更新版本，重新開啟命令提示字元或 PowerShell 後，確認 `node --version` 有輸出，再重開批次檔。

### 工作台說找不到 Codex CLI

依 [Codex CLI 官方安裝說明](https://developers.openai.com/codex/cli/)安裝 Codex，確認 `codex --version` 可執行。安裝後重開 `Start-AI-Developer.bat`。

### OAuth 登入成功但無法載入模型或開始任務

檢查授權帳號及授權頁是否允許 ChatGPT 方案使用。部分帳號、工作區、地區或模型可能尚未取得支援；查看工作台顯示的錯誤資訊。不要重複授權或改用 API Key 規避資格錯誤。

### Codex 顯示失敗或任務停止

查看錯誤橫幅和該任務紀錄中的 Codex 活動。確認專案路徑存在、Codex CLI 可用、所選模型可執行該請求，並檢查用量狀態。暫時性服務錯誤可稍後由你手動繼續；用量限制不會自動重試。

### 瀏覽器無法連線或登入回不來

保持批次檔啟動視窗開啟，手動開啟 `http://127.0.0.1:1455`。確認本機連接埠 `1455` 未被占用，且瀏覽器允許回到 `127.0.0.1` 的 OAuth callback。

## 想修改 AI Developer Bridge 本身？

本節是給要修改這個工具原始碼的人。一般使用者不必執行以下指令，依照上方「使用前準備：一步一步設定」即可使用。

```powershell
npm install
npm test
npm start
```

啟動後手動開啟 `http://127.0.0.1:1455`。`npm test` 執行本機自動測試；它不等於驗證每個人的 OAuth 資格或方案用量。

## 官方文件

- [Sign in with ChatGPT：開源應用程式與 ChatGPT 方案用量](https://developers.openai.com/siwc/token-sharing-open-source)
- [註冊與登入](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [模型與推論](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [錯誤與復原](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Codex CLI](https://developers.openai.com/codex/cli/)

## 授權

本專案採用 [MIT License](LICENSE)。使用 Sign in with ChatGPT 與 ChatGPT 方案用量仍須符合 OpenAI 當前資格、政策及產品條款；公開原始碼不代表每個帳號都一定能使用此功能。
