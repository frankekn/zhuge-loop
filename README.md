# Zhuge Loop

有武將工作法的 agent loop runtime。

`zhuge-loop` 做一件事：以 turn 為單位，反覆執行你指定的 shell 命令，搭配單實例鎖、失敗熔斷、完整日誌，讓自動化迴圈可以跑 24 小時以上而不失控。

---

## 10 分鐘跑起來

```bash
npx zhuge-loop quickstart
```

這一條命令做三件事：
1. 偵測你的專案類型（Node.js / Python / Vite / 通用）
2. 產出 `zhuge.config.json`
3. 跑第一輪 turn 驗證可行性

跑完後看終端輸出。成功的話，接下來改 config 就好。

---

## 換成你的命令

打開 `zhuge.config.json`，找到 `profiles → default → phases`，把 `command` 換成你自己的指令：

```json
{
  "profiles": {
    "default": {
      "phases": [
        { "id": "plan",      "command": "你的規劃指令",   "timeoutMs": 600000,  "allowFailure": false },
        { "id": "implement", "command": "你的實作指令",   "timeoutMs": 1200000, "allowFailure": false },
        { "id": "verify",    "command": "npm test",       "timeoutMs": 900000,  "allowFailure": false }
      ]
    }
  }
}
```

跑一輪確認沒問題：

```bash
npx zhuge-loop run --once
```

持續運行：

```bash
npx zhuge-loop run
```

---

## 武將是誰

| 武將 | 職責 | 一句話 |
|------|------|--------|
| zhuge 諸葛亮 | 協調 | 拆任務、定方向 |
| zhaoyun 趙雲 | 實作 | 可靠交付每一行 |
| guanyu 關羽 | 審查 | 品質不妥協 |

在 `zhuge-team` preset 裡，三位武將對應三個 profile，以 turn 為單位輪替執行。每個 profile 有各自的 phases（shell 命令）。

---

## 進階：多將協作

```bash
npx zhuge-loop init --preset zhuge-team
```

產出的 config 會包含三個 profile（zhuge / zhaoyun / guanyu），`profileRotation` 按順序輪替。你只需要把每個 profile 裡的 `command` 換成實際的 agent 或腳本指令。

---

## 最小 config 範例

一個最簡單的 solo 設定：

```json
{
  "name": "my-project",
  "sleepMs": 120000,
  "maxConsecutiveFailures": 3,
  "keepRecentTurns": 30,
  "profileRotation": ["default"],
  "profiles": {
    "default": {
      "description": "Plan -> implement -> verify",
      "phases": [
        { "id": "plan",      "command": "echo '[plan] pick the smallest slice'", "timeoutMs": 600000,  "allowFailure": false },
        { "id": "implement", "command": "echo '[impl] run your agent here'",     "timeoutMs": 1200000, "allowFailure": false },
        { "id": "verify",    "command": "npm test",                               "timeoutMs": 900000,  "allowFailure": false }
      ]
    }
  }
}
```

---

## Core Concepts

- **Turn**：一個完整的執行週期。每個 turn 執行一個 profile 的所有 phases。
- **Profile**：具名的工作流程，包含有序的 phases。
- **Phase**：一條 shell 命令，搭配 timeout 和失敗策略（`allowFailure`）。
- **Rotation**：決定每個 turn 跑哪個 profile。`profileRotation` 陣列依序輪替。

---

## 運行穩定性

Zhuge Loop 為長時間無人值守運行而設計：

- **單實例鎖**：同一個 `.zhuge-loop/zhuge-loop.lock` 只允許一個 process。如果前一個 process 已死亡，自動清理 stale lock。
- **失敗熔斷**：連續失敗次數達到 `maxConsecutiveFailures` 時自動停機，避免錯誤無限循環。停機原因記錄在 `.zhuge-loop/HALT.log`。
- **Turn 日誌**：每輪的 context、stdout、stderr、結果摘要完整落地，方便事後追查。舊日誌依 `keepRecentTurns` 自動清理。
- **SIGINT / SIGTERM 處理**：收到信號後在當前 turn 結束時優雅停止，不會在 phase 執行途中強制中斷。

---

## Log and State Layout

所有 runtime 產物預設在 `.zhuge-loop/` 目錄下：

```
.zhuge-loop/
  zhuge-loop.lock          # 單實例鎖（執行中存在，結束時刪除）
  state.json               # turn 計數器、最近結果、連續失敗數
  HALT.log                 # 熔斷停機記錄（觸發時才出現）
  logs/
    turn-000000-20260219T.../
      context.json         # 該 turn 的 profile、phases 資訊
      01-plan.stdout.log   # phase stdout
      01-plan.stderr.log   # phase stderr
      02-implement.stdout.log
      02-implement.stderr.log
      result.json          # turn 結果（結構化）
      result.md            # turn 結果（人類可讀）
```

---

## Available Presets

用 `--preset` 指定初始化模板：

```bash
npx zhuge-loop init --preset <name>
```

| Preset | 說明 |
|--------|------|
| `zhuge-solo` | 單 agent，三個 phase（plan / implement / verify），預設 |
| `zhuge-team` | 三位武將輪替（zhuge / zhaoyun / guanyu） |
| `node-lib` | Node.js 專案（verify: `npm test`） |
| `react-vite` | React / Vite 專案（verify: `npx vitest run`） |
| `python` | Python 專案（verify: `pytest`） |
| `generic` | 通用（verify: `echo ok`） |
| `claude-code` | Claude Code CLI 作為 implement agent |
| `kiro` | Kiro CLI 作為 implement agent |

---

## CLI 命令一覽

```bash
npx zhuge-loop quickstart                     # 偵測、產 config、跑第一輪
npx zhuge-loop init                           # 互動式設定精靈
npx zhuge-loop init --preset zhuge-team       # 用指定 preset 產 config
npx zhuge-loop run --once                     # 跑一輪
npx zhuge-loop run                            # 持續運行
npx zhuge-loop doctor                         # 檢查 phase 命令是否可用
npx zhuge-loop doctor --strict                # 嚴格檢查（含目錄權限、git 狀態）
```

---

## Config Reference

完整 config 欄位：

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `name` | string | `"zhuge-loop"` | 專案名稱 |
| `repoDir` | string | `"."` | 專案根目錄（相對於 config 檔位置） |
| `runtimeDir` | string | `".zhuge-loop"` | runtime 產物目錄 |
| `sleepMs` | number | `120000` | 每輪之間的等待時間（毫秒） |
| `maxConsecutiveFailures` | number | `3` | 連續失敗幾次後熔斷停機 |
| `keepRecentTurns` | number | `30` | 保留最近幾輪的日誌 |
| `profileRotation` | string[] | `["default"]` | profile 輪替順序 |
| `profiles` | object | -- | 各 profile 定義 |
| `profiles.<name>.description` | string | -- | profile 描述 |
| `profiles.<name>.phases` | array | -- | 有序的 phase 列表 |
| `profiles.<name>.phases[].id` | string | -- | phase 識別名稱 |
| `profiles.<name>.phases[].command` | string | -- | 要執行的 shell 命令 |
| `profiles.<name>.phases[].timeoutMs` | number | `600000` | phase 超時（毫秒） |
| `profiles.<name>.phases[].allowFailure` | boolean | `false` | 是否允許該 phase 失敗而不中斷 turn |

---

## FAQ

**Q: 需要什麼環境？**
A: Node.js >= 20，沒有其他依賴。

**Q: 可以不用三國主題嗎？**
A: 可以。用 `--preset generic` 就是一個乾淨的 plan / implement / verify 迴圈，不帶任何武將命名。

**Q: phase 的 command 可以放什麼？**
A: 任何可在 terminal 執行的 shell 命令。可以是 `npm test`、`pytest`、`claude --dangerously-skip-permissions -p "..."`，或你自己的腳本。

**Q: 連續失敗熔斷後怎麼恢復？**
A: 修復問題後直接 `npx zhuge-loop run`。熔斷只是停止迴圈，不會修改 state。上次的 turn 編號會繼續遞增。

**Q: 可以同時跑多個 instance 嗎？**
A: 不行。同一個 `.zhuge-loop/` 目錄下只允許一個 process，由 lock 機制保證。如果前一個 process 已死亡，lock 會自動清理。

**Q: 如何查看某一輪的執行結果？**
A: 看 `.zhuge-loop/logs/turn-*/result.md`，裡面有 profile、各 phase 的 exit code、耗時和錯誤摘要。

---

## License

MIT
