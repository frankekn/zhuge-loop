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

3. Edit `zhuge.config.json` commands for your own workflow.

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
- Phase: a shell command with timeout and failure policy.
- Rotation: which profile runs for each turn.

You can model playability/maintainability/strategy as three profiles and rotate by turn.

## Config example

```json
{
  "name": "my-product-loop",
  "repoDir": ".",
  "sleepMs": 120000,
  "maxConsecutiveFailures": 3,
  "profileRotation": ["playability", "maintainability"],
  "profiles": {
    "playability": {
      "description": "Ship user-visible slices",
      "phases": [
        {
          "id": "implement",
          "command": "codex run --profile playability",
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
    },
    "maintainability": {
      "description": "Refactor and harden",
      "phases": [
        {
          "id": "refactor",
          "command": "codex run --profile maintainability",
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
- `.zhuge-loop/logs/turn-*/`: per-turn context, stdout/stderr, and result summary.
- `.zhuge-loop/HALT.log`: records failure-fuse halts.

## OpenClaw as bridge

OpenClaw is a useful control bridge, but Zhuge Loop is intentionally standalone.
Use OpenClaw as an adapter command in phases, not as a hard runtime dependency.

Example adapter config: `examples/openclaw-bridge.zhuge.config.json`

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
# 修改 zhuge.config.json 內 command
node src/cli.js run --once
node src/cli.js run
```

如果你已經用 OpenClaw 控制流程，可以把 OpenClaw 指令放進 phase command，當作橋接層，不需要把核心 loop 綁死在 OpenClaw 裡。
