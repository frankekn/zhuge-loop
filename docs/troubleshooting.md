# Troubleshooting

## LOCKED: another instance is running

```
[zhuge-loop] LOCKED: another instance is running (pid=12345 since 2025-01-01T00:00:00.000Z). Lock: .zhuge-loop/zhuge-loop.lock
```

**Cause**: Another zhuge-loop process is already running, or a previous process crashed without releasing the lock.

**Fix**:
1. Check if the process is actually running: `ps aux | grep zhuge-loop`
2. If it's not running, the lock is stale. Delete it: `rm .zhuge-loop/zhuge-loop.lock`
3. zhuge-loop will also auto-recover stale locks (checks PID liveness on next run).

## HALT: consecutive failures reached N/N

```
HALT: consecutive failures reached 3/3
Recent failures:
  turn 5: Phase verify failed with code 1
  turn 6: Phase verify failed with code 1
  turn 7: Phase verify failed with code 1
```

**Cause**: The failure fuse tripped because `maxConsecutiveFailures` consecutive turns failed.

**Fix**:
1. Check `.zhuge-loop/HALT.log` for the failure summary.
2. Check the most recent turn logs in `.zhuge-loop/logs/turn-*/` for stdout/stderr.
3. Fix the underlying issue (broken test, missing dependency, etc.).
4. Run `zhuge-loop run --once` to verify the fix.
5. Resume continuous operation: `zhuge-loop run`

## Config validation errors

```
[zhuge-loop] sleepMs must be a positive integer, got "120"
```

**Cause**: Config field has wrong type.

**Fix**: Check `zhuge.config.json`. Common mistakes:
- `sleepMs` should be a number, not a string: `120000` not `"120000"`
- `profileRotation` must reference profiles that exist in `profiles`
- Every phase needs both `id` and `command`

Run `zhuge-loop doctor` to validate your config.

## Phase command not found

```
Doctor summary:
  [MISSING] default/verify: pytest
```

**Cause**: The command in a phase is not available in the shell PATH.

**Fix**:
1. Install the missing command.
2. Or update the phase command in `zhuge.config.json`.
3. Re-run `zhuge-loop doctor` to confirm.

## Quickstart detects wrong project type

**Cause**: `quickstart` checks for files in this order: `vite.config.*` > `package.json` > `pyproject.toml`/`requirements.txt` > generic.

**Fix**: Run `zhuge-loop init` instead and choose the correct project type interactively, or use `--preset`:
```bash
zhuge-loop init --preset python
```

## Turn logs consuming too much disk space

**Fix**: Reduce `keepRecentTurns` in `zhuge.config.json`:
```json
{
  "keepRecentTurns": 10
}
```

Old turn directories beyond this limit are automatically deleted.

## Process not stopping cleanly

**Cause**: zhuge-loop waits for the current phase command to finish before stopping.

**Fix**:
1. Send SIGTERM: `kill <pid>` — zhuge-loop will finish the current phase and exit.
2. Send SIGTERM again or SIGKILL if it's stuck: `kill -9 <pid>`
3. The lock file will be cleaned up on next run (stale lock recovery).
