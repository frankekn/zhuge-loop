# Architecture

## Runtime Flow

1. Load config (`normalizeConfig` validates all fields).
2. Acquire single-instance lock (atomic `wx` flag, stale-lock recovery).
3. Load state from `state.json`.
4. Select profile: `profileRotation[turn % profileRotation.length]`.
5. Execute phases in order, injecting `ZHUGE_TURN`, `ZHUGE_PROFILE`, `ZHUGE_PHASE` env vars.
6. Write per-turn logs: `context.json`, `stdout/stderr`, `result.json`, `result.md`.
7. Update state (`turn`, `consecutiveFailures`, recent results).
8. If failure fuse is hit, write HALT log with recent failure summary and exit with code 50.
9. Clean old turn logs beyond `keepRecentTurns`.
10. Sleep and continue (or exit if `--once`).

## CLI Commands

| Command | Description |
|---|---|
| `quickstart` | Detect project type, write config, run first turn |
| `init [--preset]` | Interactive wizard or preset-based config generation |
| `run [--once]` | Start the loop (or run single turn) |
| `doctor [--strict]` | Validate config and check command availability |

## Components

```
cli.js          Command interface (quickstart, init, run, doctor)
config.js       Config loading, validation, presets, project detection
loop.js         Orchestrator runtime (turn execution, rotation, fuse)
runner.js       Shell command execution (timeout, process-group kill)
lock.js         Single-instance lock (atomic create, stale recovery, token verification)
state.js        State persistence (turn counter, results history)
utils.js        Shared utilities (mkdirp, readJson, writeJson, sleep, truncate)
```

## Preset System

Presets are predefined config templates in `config.js:PRESETS`. Categories:

- **Mode**: `zhuge-solo` (default), `zhuge-team`
- **Project**: `node-lib`, `react-vite`, `python`, `generic`
- **Vendor**: `claude-code`, `kiro`

`detectProjectType(repoDir)` checks for `vite.config.*`, `package.json`, `pyproject.toml` to auto-select preset.

## Design Notes

- Zero runtime dependencies. Only Node.js built-in modules.
- Logs are append-only per turn for auditability.
- Runtime files are isolated under `.zhuge-loop/`.
- Phase commands are shell-level adapters, so the loop is tool-agnostic.
- Profile rotation is round-robin via modular arithmetic.
- Lock uses `wx` flag for atomic creation, with PID-based stale detection.
- Process cleanup: `detached: true` + SIGTERM to process group, SIGKILL after 3s.
