# Playit startup fix in v0.1.26

The installed v0.1.25 panel's authenticated Start Tunnel Agent request returned
502. Repeating its exact arguments with the installed official Playit 0.17.1
binary exposed an immediate panic: `try to use -s and -l at the same time`
(exit code 101). The discarded standard error and unchanged log file hid the
cause from the panel.

The managed start command now selects file logging only. Account linking still
uses stdout because it reads the claim URL and does not request file logging.
Immediate exits include their exit code in the API error; operating-system launch
errors are also reported instead of a successful start.

## Verification

- Windows type checks and production build passed.
- The complete local suite passed 242 tests, with one Linux-only test skipped.
- Seven Playit service tests cover claim/repair and startup, including the exact
  launch arguments, repeated starts, immediate exits/retries and launch errors.
- All six existing Playit browser regression scenarios passed: popup-blocked
  linking, retry, and successful/failed approval with existing credentials.
- The compiled service launched the real installed Playit 0.17.1 agent, retained
  the same process on a repeated start, and reached registered, running tunnels.
  The existing credential file's SHA-256 was unchanged. The diagnostic stopped
  only its own child process.

Real network registration was tested on Windows. Linux command construction is
covered by the same service tests; no live Linux Playit connection was exercised
locally. This check does not establish Minecraft reachability through a tunnel.
