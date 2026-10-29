# Luanti world session boundary — 2026-10-29

This evidence records the first runtime integration step for the independent
Wispiva product branch. `engine/luanti/launch.py` starts a child Luanti
process only after entering `WorldSession`; the session remains held until the
child exits, forwards termination signals, and exposes the stable world UUID as
`WISPIVA_WORLD_ID` to the child environment.

The normal launcher establishes the identity before adding Luanti files. A
non-empty directory without an identity is rejected, so a legacy directory
cannot be silently adopted as a different world. The confirmed-origin preview
uses the same process boundary.

## Verification

The focused checks run on the worktree were:

```text
python3 -B -m unittest -v engine/luanti/test_launch.py engine/luanti/test_world_session.py
python3 -B -m unittest -v genesis/test_preview.py genesis/test_cli.py
bash -n engine/luanti/run.sh
python3 -m py_compile engine/luanti/launch.py genesis/preview.py
```

All 28 tests passed. The cross-process launcher test proves that a second
session receives `BlockingIOError` while the child is alive, then can enter
after the child exits; a second test proves that the launcher's exit code is
the child's exit code.

## Scope

This is a process access boundary, not the completed world state contract. The
Luanti map, event history, inventory projection and role memory still do not
share one commit or crash-recovery protocol. The Unix lock remains cooperative
and cannot stop players, mods or other processes that bypass the launcher.
