# Architecture

## Runtime flow

1. Load config.
2. Acquire single-instance lock.
3. Load state.
4. Select profile based on current turn and rotation.
5. Collect repo context once at turn start from `context.commands`.
6. Optionally query Linear tasks once at turn start.
7. Normalize each phase into a runner shape (`shell` or `kiro`).
8. Execute phases in order.
9. For Kiro phases, compose prompt from repo context + optional Linear context + phase prompt + previous phase handoff.
10. Parse Linear markers from phase output and sync task state when enabled.
11. Optionally auto-commit and auto-push successful phase changes according to `repoPolicy`.
12. Persist logs + turn result.
13. Update state (`turn`, `consecutiveFailures`, recent results).
14. If failure fuse is hit, write HALT log and exit with code 50.
15. Sleep and continue.

## Components

- `src/cli.js`: command interface (`init`, `run`, `doctor`).
- `src/config.js`: config loading and validation.
- `src/context.js`: repo-context collection and handoff/prompt composition.
- `src/linear.js`: Linear task query, context injection, and marker handling.
- `src/loop.js`: orchestrator runtime.
- `src/repo.js`: delivery branch management and auto-commit/auto-push.
- `src/runner.js`: phase dispatcher and shell/Kiro execution.
- `src/acp.js`: minimal ACP client for Kiro ACP execution.
- `src/kiro.js`: `kiro-cli-chat` fallback runner.
- `src/lock.js`: single-instance lock and stale-lock recovery.
- `src/state.js`: state persistence.

## Design notes

- Logs are append-only per turn for auditability.
- Runtime files are isolated under `.zhuge-loop/`.
- Public phase syntax is normalized into an internal runner union.
- Legacy `phase.command` configs are converted to `run.kind="shell"` during config load.
- Kiro phases are ACP-first with single-phase fallback to `kiro-cli-chat`.
- Repo context is collected once per turn and written to `repo-context.txt`.
- Linear context can be collected once per turn and written to `linear-context.txt`.
- Previous phase stdout is truncated into a handoff and passed to the next phase.
- Shell phases receive repo context/handoff through environment variables; Kiro phases receive them inside the composed prompt.
- Linear markers are parsed from phase stdout; task transitions and task creation happen through the configured Linear CLI.
- Auto-commit/auto-push is opt-in through `repoPolicy`; commit subjects are generated from the current active Linear task when available.
