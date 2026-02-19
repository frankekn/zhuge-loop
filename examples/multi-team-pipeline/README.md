# Multi-Team Pipeline Example

## Overview

This example demonstrates a **coordinator -> executor -> reviewer** pipeline using zhuge-loop's profile rotation mechanism. Three profiles represent Three Kingdoms generals, each with a distinct role in the development loop.

## Rotation Pattern

The `profileRotation` array defines the turn order:

```
["zhuge", "zhaoyun", "zhaoyun", "guanyu"]
```

Each cycle of 4 turns executes the following sequence:

| Turn | Profile  | Role       | Phases                |
|------|----------|------------|-----------------------|
| 1    | zhuge    | Coordinator | plan, prioritize     |
| 2    | zhaoyun  | Executor    | implement, test      |
| 3    | zhaoyun  | Executor    | implement, test      |
| 4    | guanyu   | Reviewer    | review, report       |

After turn 4, the rotation wraps back to turn 1 and repeats.

## Why 2:1 Implement-to-Review Ratio

The rotation includes `zhaoyun` twice for every one `guanyu` turn. This reflects a practical observation: implementation takes more turns than review. Two consecutive executor turns allow the pipeline to make meaningful progress on a slice before pausing for quality review. If your project needs more review coverage (for example, a safety-critical codebase), adjust the ratio to `["zhuge", "zhaoyun", "guanyu"]` (1:1) or even add multiple review turns.

## How to Run

From the repository root:

```bash
zhuge-loop run --once --config examples/multi-team-pipeline/zhuge.config.json
```

The `--once` flag runs a single turn and exits, which is useful for testing the config before enabling the continuous loop.

To run the full loop:

```bash
zhuge-loop run --config examples/multi-team-pipeline/zhuge.config.json
```

## Customization

The example config uses `echo` placeholder commands. To use this config in a real project, replace the echo commands with actual agent CLI invocations. For example:

```json
{
  "id": "implement",
  "command": "claude --dangerously-skip-permissions -p 'Implement the slice described in .zhuge-loop/current-slice.md'",
  "timeoutMs": 1200000,
  "allowFailure": false
}
```

Other agents (Codex, Kiro, etc.) can be substituted in the same way -- zhuge-loop is agent-agnostic.

## Config Notes

- `repoDir` is set to `"../.."` because the config file lives two levels below the repository root.
- `keepRecentTurns` is set to 50 (higher than the default 30) to retain more history, which is helpful when debugging multi-profile pipelines.
- `sleepMs: 120000` (2 minutes) gives the system breathing room between turns.
