# Architecture

## Runtime flow

1. Load config.
2. Acquire single-instance lock.
3. Load state.
4. Select profile based on current turn and rotation.
5. Execute phases in order.
6. Persist logs + turn result.
7. Update state (`turn`, `consecutiveFailures`, recent results).
8. If failure fuse is hit, write HALT log and exit with code 50.
9. Sleep and continue.

## Components

- `src/cli.js`: command interface (`init`, `run`, `doctor`).
- `src/config.js`: config loading and validation.
- `src/loop.js`: orchestrator runtime.
- `src/runner.js`: shell command execution with timeout handling.
- `src/lock.js`: single-instance lock and stale-lock recovery.
- `src/state.js`: state persistence.

## Design notes

- Logs are append-only per turn for auditability.
- Runtime files are isolated under `.zhuge-loop/`.
- Phase commands are shell-level adapters, so the loop is tool-agnostic.
