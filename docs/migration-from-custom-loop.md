# Migration from Custom Loop

從你自己的 bash/shell 迴圈腳本遷移到 zhuge-loop。

---

## Why Migrate

自寫的 `while true` 迴圈能跑，但長時間無人值守時會遇到這些問題：

- **重複執行**：忘記檢查 PID，開了兩個 terminal 就跑了兩份。zhuge-loop 有 single-instance lock 搭配 stale recovery，不可能 double-run。
- **錯誤無限循環**：腳本壞了就一直重試，直到你手動 kill。zhuge-loop 的 `maxConsecutiveFailures` 熔斷機制會自動停機，原因記錄在 `HALT.log`。
- **事後追查困難**：stdout 混在一起，不知道第幾輪出的問題。zhuge-loop 每個 turn 獨立一組 log（stdout / stderr / result），方便 postmortem。
- **多關注面切換麻煩**：想輪流跑不同任務要自己寫 counter 和 if-else。zhuge-loop 的 `profileRotation` 直接宣告輪替順序。

---

## Concept Mapping

| Custom Loop 做法 | zhuge-loop 對應 |
|---|---|
| `while true; do ... done` | `zhuge-loop run` |
| `sleep 120` | config 裡的 `sleepMs: 120000` |
| 不同腳本手動切換 | `profiles` + `profileRotation` 自動輪替 |
| 自己寫 PID file | 自動 lock（`.zhuge-loop/zhuge-loop.lock`），含 stale recovery |
| 自己維護 counter 變數 | `state.json` 裡的 turn number，自動遞增 |
| Crash 後狀態遺失 | 每個 turn 結束後 state 持久化 |
| `if fail N times; then exit; fi` | `maxConsecutiveFailures` 熔斷 |
| `>> output.log 2>&1` | 自動 per-turn stdout/stderr log，舊的依 `keepRecentTurns` 清理 |
| 手動管 timeout | 每個 phase 有 `timeoutMs`，超時自動 kill |

---

## Step-by-Step Migration

### Step 1: Install

```bash
npx zhuge-loop quickstart
```

這會偵測專案類型、產出 `zhuge.config.json`、跑第一輪 turn 驗證。

如果你想手動控制，也可以分步來：

```bash
npx zhuge-loop init --preset generic
```

### Step 2: 把你的 commands 搬進 config

假設你原本的 bash 迴圈長這樣：

```bash
#!/bin/bash
while true; do
  echo "[plan] picking next task..."
  claude --agent planner

  echo "[implement] working on it..."
  claude --agent implementer

  echo "[verify] running tests..."
  npm test

  sleep 120
done
```

對應的 `zhuge.config.json`：

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
        {
          "id": "plan",
          "command": "claude --agent planner",
          "timeoutMs": 600000,
          "allowFailure": false
        },
        {
          "id": "implement",
          "command": "claude --agent implementer",
          "timeoutMs": 1200000,
          "allowFailure": false
        },
        {
          "id": "verify",
          "command": "npm test",
          "timeoutMs": 900000,
          "allowFailure": false
        }
      ]
    }
  }
}
```

對照說明：

| bash 迴圈裡的部分 | config 裡的對應 |
|---|---|
| `claude --agent planner` | `phases[0].command` |
| `claude --agent implementer` | `phases[1].command` |
| `npm test` | `phases[2].command` |
| `sleep 120` | `sleepMs: 120000`（迴圈層級，不在 phase 裡） |
| 整個 `while true` | `zhuge-loop run` 本身就是無限迴圈 |

重點：每個 phase 是獨立的 shell 命令。如果某個 phase 失敗（exit code != 0）且 `allowFailure` 是 `false`，後續 phase 不會執行，該 turn 視為失敗。

### Step 3: Environment variables

你的腳本可以讀取 zhuge-loop 注入的環境變數：

| 變數 | 說明 | 範例值 |
|---|---|---|
| `ZHUGE_TURN` | 當前 turn 編號（從 0 開始） | `"42"` |
| `ZHUGE_PROFILE` | 當前 profile 名稱 | `"default"` |
| `ZHUGE_PHASE` | 當前 phase id | `"verify"` |

這些變數在每個 phase command 的 shell 環境中可用。如果你原本的腳本需要知道「現在是第幾輪」，直接讀 `$ZHUGE_TURN` 就好，不用自己維護 counter。

範例：在 phase command 裡使用

```json
{
  "id": "report",
  "command": "echo \"Turn $ZHUGE_TURN ($ZHUGE_PROFILE/$ZHUGE_PHASE) completed\" >> run.log",
  "timeoutMs": 10000,
  "allowFailure": true
}
```

### Step 4: 單輪驗證

先跑一輪確認所有 command 都能正常執行：

```bash
npx zhuge-loop run --once
```

然後用 doctor 檢查所有 phase command 的可執行性：

```bash
npx zhuge-loop doctor
```

如果需要更嚴格的檢查（含目錄權限、git 狀態）：

```bash
npx zhuge-loop doctor --strict
```

Doctor 會逐一檢查每個 profile 裡每個 phase 的 command 首個 token 是否能在 `$PATH` 中找到。

### Step 5: 持續運行

確認沒問題後：

```bash
npx zhuge-loop run
```

迴圈會一直跑，每輪之間 sleep `sleepMs` 毫秒。收到 SIGTERM 或 SIGINT 時會在當前 phase 結束後優雅停止。

---

## Common Patterns

### Pattern 1: Single concern loop

**Before** -- 單一腳本無限迴圈：

```bash
while true; do
  my-script.sh
  sleep 60
done
```

**After** -- 單一 profile、單一 phase：

```json
{
  "sleepMs": 60000,
  "maxConsecutiveFailures": 3,
  "profileRotation": ["default"],
  "profiles": {
    "default": {
      "phases": [
        { "id": "run", "command": "my-script.sh", "timeoutMs": 600000, "allowFailure": false }
      ]
    }
  }
}
```

你的 `my-script.sh` 完全不用改。

### Pattern 2: Multi-step pipeline

**Before** -- 腳本內有多個步驟，任一步失敗就跳過後續：

```bash
while true; do
  step1.sh && step2.sh && step3.sh
  sleep 120
done
```

**After** -- 多個 phases，失敗自動中止後續：

```json
{
  "sleepMs": 120000,
  "profileRotation": ["default"],
  "profiles": {
    "default": {
      "phases": [
        { "id": "step1", "command": "step1.sh", "timeoutMs": 600000, "allowFailure": false },
        { "id": "step2", "command": "step2.sh", "timeoutMs": 600000, "allowFailure": false },
        { "id": "step3", "command": "step3.sh", "timeoutMs": 600000, "allowFailure": false }
      ]
    }
  }
}
```

好處：每個 step 的 stdout/stderr 獨立存檔，事後可以精確定位是哪一步出的問題。

如果某些步驟失敗不應該中止整個 turn，把 `allowFailure` 設為 `true`：

```json
{ "id": "lint", "command": "npm run lint", "timeoutMs": 60000, "allowFailure": true }
```

### Pattern 3: Multi-concern rotation

**Before** -- 用 cron 或手動切換跑不同任務：

```bash
# crontab
0 * * * * /path/to/feature-work.sh
30 * * * * /path/to/refactor-work.sh
```

或在腳本裡自己寫輪替邏輯：

```bash
counter=0
while true; do
  if (( counter % 2 == 0 )); then
    feature-work.sh
  else
    refactor-work.sh
  fi
  counter=$((counter + 1))
  sleep 120
done
```

**After** -- 多個 profiles 搭配 `profileRotation`：

```json
{
  "sleepMs": 120000,
  "profileRotation": ["feature", "refactor"],
  "profiles": {
    "feature": {
      "description": "Feature development",
      "phases": [
        { "id": "plan",   "command": "feature-plan.sh",   "timeoutMs": 600000,  "allowFailure": false },
        { "id": "impl",   "command": "feature-impl.sh",   "timeoutMs": 1200000, "allowFailure": false },
        { "id": "verify", "command": "npm test",           "timeoutMs": 900000,  "allowFailure": false }
      ]
    },
    "refactor": {
      "description": "Refactoring and hardening",
      "phases": [
        { "id": "analyze", "command": "refactor-analyze.sh", "timeoutMs": 600000,  "allowFailure": false },
        { "id": "apply",   "command": "refactor-apply.sh",   "timeoutMs": 1200000, "allowFailure": false },
        { "id": "verify",  "command": "npm test",             "timeoutMs": 900000,  "allowFailure": false }
      ]
    }
  }
}
```

Turn 0 跑 `feature`，turn 1 跑 `refactor`，turn 2 回到 `feature`，依此類推。

`profileRotation` 也支援不等比例輪替。如果你想 feature 跑兩輪、refactor 跑一輪：

```json
"profileRotation": ["feature", "feature", "refactor"]
```

---

## FAQ

### 我現有的 scripts 能直接用嗎？

可以。把你的 script 路徑直接放在 phase 的 `command` 裡就好。zhuge-loop 執行的是 shell command，所以 `./my-script.sh`、`bash scripts/run.sh`、`python main.py` 都可以。你的 script 不需要做任何修改。

### 我原本有自己的 PID file 機制，需要移除嗎？

建議移除。zhuge-loop 內建的 lock 機制（`.zhuge-loop/zhuge-loop.lock`）已經處理了單實例保證和 stale lock recovery。兩套 lock 並存可能造成混淆。

### 如何優雅停止迴圈？

送 `SIGTERM` 或 `SIGINT`（Ctrl+C）。zhuge-loop 會在當前 phase 執行完畢後停止，不會在 phase 途中強制中斷。

### 連續失敗熔斷後怎麼恢復？

修復問題後直接 `npx zhuge-loop run`。熔斷只是停止迴圈，state 裡的 turn number 會繼續遞增，不需要手動 reset。停機原因記錄在 `.zhuge-loop/HALT.log`，可以看到是哪個 profile/phase 出的問題。

### state.json 長什麼樣？

```
.zhuge-loop/state.json
```

包含 turn 計數器、最近結果摘要、連續失敗數。zhuge-loop 每個 turn 結束後自動更新，你不需要手動編輯。

### 原本用 `nohup` 或 `screen` 跑的迴圈，遷移後也一樣嗎？

一樣。你可以用 `nohup npx zhuge-loop run &` 或在 `tmux`/`screen` 裡跑 `npx zhuge-loop run`。zhuge-loop 本身不處理 daemon 化，這部分跟你原本的方式一致。

### 日誌存在哪裡？

預設在 `.zhuge-loop/logs/` 下，每個 turn 一個目錄：

```
.zhuge-loop/logs/
  turn-000042-20260219T.../
    context.json           # 該 turn 的 profile、phases 資訊
    01-plan.stdout.log     # phase stdout
    01-plan.stderr.log     # phase stderr
    02-impl.stdout.log
    02-impl.stderr.log
    result.json            # turn 結果（結構化）
    result.md              # turn 結果（人類可讀）
```

舊日誌依 `keepRecentTurns` 設定自動清理（預設保留 30 輪）。
