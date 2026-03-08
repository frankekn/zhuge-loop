# Zhuge Loop

Always-on autonomous development loop designed for long-running execution.

`zhuge-loop` focuses on one thing: keep shipping small, verifiable slices in repeated turns, with lock safety, failure fuse, and auditable logs.

## Why this exists

Many loop tools optimize for flashy demos but become hard to trust during 24h+ operation.
Zhuge Loop is built for operational stability:

- Single-instance lock with stale-lock recovery.
- Turn-based orchestration with profile rotation.
- Consecutive failure fuse (`maxConsecutiveFailures`) to prevent infinite broken loops.
- Full per-turn logs for postmortem and replay.

## 60-second quick start

1. Install dependencies (none required beyond Node >= 20):

```bash
npm install
```

2. Generate a config:

```bash
node src/cli.js init
```

3. Edit `zhuge.config.json` phases for your own workflow.

4. Run one turn to validate:

```bash
node src/cli.js run --once
```

5. Run continuously:

```bash
node src/cli.js run
```

## Core concepts

- Turn: one full execution cycle.
- Profile: a named workflow with ordered phases.
- Phase: one runnable step with timeout and failure policy.
- Runner: how a phase executes. Built-in runners are `shell` and `kiro`.
- Rotation: which profile runs for each turn.

You can model playability/maintainability/strategy as three profiles and rotate by turn.

## Config example

```json
{
  "name": "my-product-loop",
  "repoDir": ".",
  "sleepMs": 120000,
  "maxConsecutiveFailures": 3,
  "context": {
    "commands": [
      {
        "name": "git-status",
        "command": "git status --porcelain",
        "timeoutMs": 5000,
        "maxLines": 50
      },
      {
        "name": "git-log",
        "command": "git log -10 --oneline",
        "timeoutMs": 5000,
        "maxLines": 50
      }
    ]
  },
  "repoPolicy": {
    "pushBranch": "agent-dev",
    "onDirty": "auto-stash",
    "autoCommitAfterEachPhase": true,
    "autoPushAfterEachPhase": true,
    "requireConventionalCommits": true,
    "commitMessageMaxLen": 100,
    "requireIssueKeyRegex": "AIR-\\d+"
  },
  "integrations": {
    "linear": {
      "enabled": true,
      "cliPath": "./tools/linear-cli.sh",
      "promptPhaseIds": ["strategist"],
      "maxTasks": 10,
      "contextMaxChars": 4000
    }
  },
  "kiro": {
    "acpCommand": "kiro-acp",
    "cliCommand": "kiro-cli-chat",
    "trustAllTools": true,
    "fallbackToCli": true
  },
  "profileRotation": ["playability", "maintainability"],
  "profiles": {
    "playability": {
      "description": "Ship user-visible slices",
      "phases": [
        {
          "id": "implement",
          "run": {
            "kind": "kiro",
            "agent": "zhuge",
            "prompt": "Implement the highest-value playability slice."
          },
          "timeoutMs": 1200000,
          "allowFailure": false
        },
        {
          "id": "verify",
          "run": {
            "kind": "shell",
            "command": "npm test"
          },
          "timeoutMs": 900000,
          "allowFailure": false
        }
      ]
    },
    "maintainability": {
      "description": "Refactor and harden",
      "phases": [
        {
          "id": "refactor",
          "run": {
            "kind": "shell",
            "command": "codex run --profile maintainability"
          },
          "timeoutMs": 1200000,
          "allowFailure": false
        }
      ]
    }
  }
}
```

## Log and state layout

By default, runtime artifacts are under `.zhuge-loop/`:

- `.zhuge-loop/state.json`: turn counter and recent results.
- `.zhuge-loop/logs/turn-*/repo-context.txt`: repo snapshot collected once at turn start.
- `.zhuge-loop/logs/turn-*/linear-context.txt`: active Linear task snapshot collected once per turn.
- `.zhuge-loop/logs/turn-*/NN-<phase>.handoff.txt`: input handoff passed into that phase.
- `.zhuge-loop/logs/turn-*/NN-<phase>.prompt.txt`: composed Kiro prompt for Kiro phases.
- `.zhuge-loop/logs/turn-*/`: per-turn context, stdout/stderr, and result summary.
- `.zhuge-loop/logs/turn-*/NN-<phase>.meta.json`: Kiro metadata for Kiro phases.
- `.zhuge-loop/HALT.log`: records failure-fuse halts.

## Standalone first

Zhuge Loop runs without OpenClaw or any specific agent framework.
The runtime only needs runnable phases in your profiles.

If your commands can run in terminal, they can run in Zhuge Loop.
If you use Kiro, phases can run through ACP first and fall back to `kiro-cli-chat`.
Kiro phases automatically receive repo context and the previous phase handoff in their composed prompt.
Shell phases receive the same inputs via `ZHUGE_REPO_CONTEXT`, `ZHUGE_REPO_CONTEXT_PATH`, `ZHUGE_HANDOFF`, and `ZHUGE_HANDOFF_PATH`.
If `integrations.linear.enabled=true`, the runtime can query active Linear tasks, inject them into selected Kiro phases, and process `[LINEAR_NEW_TASK]`, `[LINEAR_ACTIVE]`, and `[LINEAR_DONE]` markers from phase output.
If `repoPolicy.autoCommitAfterEachPhase=true`, the runtime can create local recovery/checkpoint commits to keep the worktree resumable. With `autoPushAfterEachPhase=true`, it pushes the delivery branch only after the full turn passes its required gates.

Legacy configs that use top-level `command` inside phases are still supported.
New configs should prefer `phase.run`.

## Methodology docs

- `docs/METHODOLOGY.md`
- `docs/ARCHITECTURE.md`

---

## 中文說明（重點版）

`zhuge-loop` 是一個可長時間運行的自動開發迴圈引擎，核心目標是「穩定地一輪一輪交付最小切片」。

主要特性：

- 單實例鎖（避免雙實例互相衝突）
- stale lock 自動清理
- 依 turn 輪替 profile（主線/維護/策略）
- 連續失敗熔斷（避免錯誤無限循環）
- 每輪完整落地日誌，方便追查

最簡單使用流程：

```bash
npm install
node src/cli.js init
# 修改 zhuge.config.json 內 phases
node src/cli.js run --once
node src/cli.js run
```

這個工具本身不依賴 OpenClaw。phase 可以是 shell 指令，也可以是 Kiro phase。
Kiro phase 會自動拿到每輪 repo context 與上一 phase 的 handoff；shell phase 則透過環境變數拿到相同資訊。
若啟用 Linear integration，runtime 也會查詢目前任務、把任務清單注入指定 phase，並自動處理 `[LINEAR_NEW_TASK]` / `[LINEAR_ACTIVE]` / `[LINEAR_DONE]` markers。
若啟用 `repoPolicy.autoCommitAfterEachPhase` / `autoPushAfterEachPhase`，runtime 可能建立本地 recovery/checkpoint commit 來避免髒工作樹卡死；只有整輪 gate 通過後才會 push。

---

## Optional integration: OpenClaw bridge

If you already use OpenClaw as your control plane, plug it in as phase commands only.
Zhuge Loop remains the runtime/orchestrator.

Example config: `examples/openclaw-bridge.zhuge.config.json`

## Optional integration: Kiro bridge

If you already use Kiro CLI / ACP, use the built-in `kiro` runner in phase definitions.
The runtime will try ACP first and fall back to `kiro-cli-chat` for the same phase.

Example config: `examples/kiro.zhuge.config.json`

## 進階整合：OpenClaw 橋接（可選）

若你已經用 OpenClaw 做控制面，可以把 OpenClaw 指令填進 shell phase。
核心 orchestrator 仍然是 Zhuge Loop，不會被綁定在 OpenClaw。

## 進階整合：Kiro（可選）

若你已經用 Kiro CLI / ACP，可以在 phase 內使用 `run.kind = "kiro"`。
runtime 會優先走 ACP，失敗時自動回退到 `kiro-cli-chat`。
