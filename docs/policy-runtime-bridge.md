# Policy-Runtime Bridge

## Overview

在 agent 開發中有兩個獨立的設定層：

- **Policy 層** (AGENTS.md / CLAUDE.md) -- 定義 agent 「應該做什麼」：角色、職責、工具限制、行為規範。
- **Runtime 層** (zhuge.config.json) -- 定義「怎麼跑、什麼時候跑」：profile 輪替順序、phase 命令、timeout、熔斷策略。

Policy 層是靜態宣告，runtime 層是動態執行。zhuge-loop 負責 runtime 層，透過環境變數把執行 context 傳給 agent，讓 agent 在 policy 規範下正確行動。

---

## Environment Variables

zhuge-loop 在執行每個 phase command 時，會注入以下環境變數（原始碼位於 `src/loop.js` 第 82-87 行）：

```js
env: {
  ...process.env,
  ZHUGE_TURN: String(state.turn),
  ZHUGE_PROFILE: profileName,
  ZHUGE_PHASE: phase.id,
},
```

| 變數 | 型別 | 說明 |
|------|------|------|
| `ZHUGE_TURN` | string (數字) | 當前 turn 編號，從 0 開始遞增 |
| `ZHUGE_PROFILE` | string | 本輪使用的 profile 名稱，例如 `"zhuge"` 或 `"default"` |
| `ZHUGE_PHASE` | string | 當前正在執行的 phase id，例如 `"plan"` 或 `"implement"` |

這三個變數會和原本的 `process.env` 合併後傳給子 process。你的 agent CLI 或腳本可以直接讀取它們來調整行為。

---

## Mapping Rules

Policy 檔案中的概念如何對應到 runtime config：

| Policy (AGENTS.md) | Runtime (zhuge.config.json) | 說明 |
|---|---|---|
| Agent role (例如 coordinator) | Profile name (例如 `"zhuge"`) | 一個 agent role 對應一個 profile |
| Agent responsibilities | Phase commands | 職責拆解為具體的 shell 命令序列 |
| Agent tools / capabilities | Phase command args | 工具限制透過命令參數傳遞 (例如 `--allowedTools`) |
| Rotation priority | `profileRotation` array | 排列順序和重複次數決定輪替權重 |

關鍵原則：Profile 的選擇邏輯是 `profileRotation[turn % profileRotation.length]`（見 `src/loop.js` 第 16 行）。這意味著 turn 編號對 rotation 陣列長度取餘數，即可確定本輪使用哪個 profile。

---

## Case Studies

### Case 1: Solo Development

**Policy 描述**：AGENTS.md 定義一個 agent 負責所有工作 -- 規劃、實作、驗證。

**Runtime 對應**：單一 profile `"default"`，包含三個 phases。

```json
{
  "profileRotation": ["default"],
  "profiles": {
    "default": {
      "description": "Solo agent: plan, implement, verify",
      "phases": [
        {
          "id": "plan",
          "command": "claude --dangerously-skip-permissions -p 'Read the task list and pick the next slice to work on'",
          "timeoutMs": 600000,
          "allowFailure": false
        },
        {
          "id": "implement",
          "command": "claude --dangerously-skip-permissions -p 'Implement the planned change'",
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

每個 turn 都執行同一個 profile，因為 `profileRotation` 只有一個元素。Turn 0, 1, 2, ... 全部跑 `"default"`。

---

### Case 2: Three Generals Pipeline

**Policy 描述**：AGENTS.md 定義三個 agent：
- zhuge（諸葛亮）-- 協調者，拆任務、定方向
- zhaoyun（趙雲）-- 執行者，實作交付
- guanyu（關羽）-- 審查者，品質把關

**Runtime 對應**：三個 profile，`profileRotation` 按順序輪替。

```json
{
  "profileRotation": ["zhuge", "zhaoyun", "guanyu"],
  "profiles": {
    "zhuge": {
      "description": "Coordinator: break down tasks and set direction",
      "phases": [
        {
          "id": "plan",
          "command": "claude --dangerously-skip-permissions -p 'Review progress and plan the next task'",
          "timeoutMs": 600000,
          "allowFailure": false
        }
      ]
    },
    "zhaoyun": {
      "description": "Executor: implement the planned task",
      "phases": [
        {
          "id": "implement",
          "command": "claude --dangerously-skip-permissions -p 'Implement the task described in the plan'",
          "timeoutMs": 1200000,
          "allowFailure": false
        },
        {
          "id": "self-test",
          "command": "npm test",
          "timeoutMs": 900000,
          "allowFailure": false
        }
      ]
    },
    "guanyu": {
      "description": "Reviewer: review code quality and correctness",
      "phases": [
        {
          "id": "review",
          "command": "claude --dangerously-skip-permissions -p 'Review the latest changes for quality issues'",
          "timeoutMs": 600000,
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

輪替順序：

| Turn | turn % 3 | Profile |
|------|-----------|---------|
| 0 | 0 | zhuge |
| 1 | 1 | zhaoyun |
| 2 | 2 | guanyu |
| 3 | 0 | zhuge |
| 4 | 1 | zhaoyun |
| 5 | 2 | guanyu |

每三個 turn 為一個完整的「規劃 -> 實作 -> 審查」週期。

---

### Case 3: Weighted Rotation

**Policy 描述**：AGENTS.md 規定「實作頻率是審查的兩倍」-- zhaoyun 需要更多執行時間。

**Runtime 對應**：在 `profileRotation` 中重複 profile 名稱來設定權重。

```json
{
  "profileRotation": ["zhuge", "zhaoyun", "zhaoyun", "guanyu"],
  "profiles": {
    "zhuge": {
      "description": "Coordinator",
      "phases": [
        { "id": "plan", "command": "claude --dangerously-skip-permissions -p 'Plan next task'", "timeoutMs": 600000 }
      ]
    },
    "zhaoyun": {
      "description": "Executor",
      "phases": [
        { "id": "implement", "command": "claude --dangerously-skip-permissions -p 'Implement task'", "timeoutMs": 1200000 },
        { "id": "self-test", "command": "npm test", "timeoutMs": 900000 }
      ]
    },
    "guanyu": {
      "description": "Reviewer",
      "phases": [
        { "id": "review", "command": "claude --dangerously-skip-permissions -p 'Review changes'", "timeoutMs": 600000 }
      ]
    }
  }
}
```

`profileRotation` 長度為 4，輪替計算方式是 `turn % 4`：

| Turn | turn % 4 | Profile |
|------|-----------|---------|
| 0 | 0 | zhuge |
| 1 | 1 | zhaoyun |
| 2 | 2 | zhaoyun |
| 3 | 3 | guanyu |
| 4 | 0 | zhuge |
| 5 | 1 | zhaoyun |
| 6 | 2 | zhaoyun |
| 7 | 3 | guanyu |

每 4 個 turn 為一個完整週期。zhaoyun 在每個週期中執行 2 次，guanyu 執行 1 次 -- 實作頻率恰好是審查的兩倍。

你可以用同樣的方式設定任意比例。例如 `["zhaoyun", "zhaoyun", "zhaoyun", "guanyu"]` 就是 3:1 的實作對審查比。

---

## How Agents Read Their Context

### Shell script

```bash
#!/usr/bin/env bash
echo "Turn: $ZHUGE_TURN, Profile: $ZHUGE_PROFILE, Phase: $ZHUGE_PHASE"

# 根據 profile 調整行為
if [ "$ZHUGE_PROFILE" = "guanyu" ]; then
  echo "Running in review mode"
fi
```

### Node.js script

```js
const turn = process.env.ZHUGE_TURN
const profile = process.env.ZHUGE_PROFILE
const phase = process.env.ZHUGE_PHASE

console.log(`Turn ${turn}, profile=${profile}, phase=${phase}`)
```

### Python script

```python
import os

turn = os.environ.get("ZHUGE_TURN")
profile = os.environ.get("ZHUGE_PROFILE")
phase = os.environ.get("ZHUGE_PHASE")

print(f"Turn {turn}, profile={profile}, phase={phase}")
```

### 在 agent prompt 中使用

你可以在 phase command 中直接引用環境變數，讓 agent 知道自己的 context：

```json
{
  "id": "implement",
  "command": "claude --dangerously-skip-permissions -p 'You are $ZHUGE_PROFILE on turn $ZHUGE_TURN. Phase: $ZHUGE_PHASE. Implement the next task.'",
  "timeoutMs": 1200000
}
```

shell 會在執行時展開這些變數，agent 就能收到完整的執行 context。

---

## Summary

| 你想達成的目標 | 在哪裡設定 |
|---|---|
| 定義 agent 的角色和行為規範 | AGENTS.md / CLAUDE.md (policy) |
| 定義執行什麼命令、多久 timeout | zhuge.config.json 的 `profiles.*.phases` (runtime) |
| 定義誰先跑、誰多跑 | zhuge.config.json 的 `profileRotation` (runtime) |
| 讓 agent 知道當前執行 context | 讀取 `ZHUGE_TURN` / `ZHUGE_PROFILE` / `ZHUGE_PHASE` 環境變數 |

Policy 和 runtime 各司其職。Policy 不需要知道 turn 機制，runtime 不需要知道 agent 的行為細節。兩者透過環境變數銜接。
