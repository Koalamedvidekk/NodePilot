# Optional Browser Players passwords

The reported client displayed EaglerX login error 9, authentication required,
instead of opening its password dialog. NodePilot now has an explicit per-server
**Require NodePilot browser passwords** setting. Existing installations retain
password protection until the owner changes it while Minecraft is stopped.

Open mode skips EaglerX's password challenge. The companion still obtains a
server-scoped identity from NodePilot through its authenticated loopback endpoint.
Only that Eagler connection's physical channel receives offline profile handling;
normal Java connections retain Microsoft authentication. Backend forwarding and
the private listener are unchanged. Missing configuration or verifier failure
denies browser login in both modes.

New open identities are persisted in SQLite. Reconnects, account conversion and
registered browser accounts retain their UUIDs and names. Revoked names and
conflicting Java/operator identities are rejected. Open mode deliberately does
not prove ownership of an unrevoked browser name; a server login plugin can do so.

## Real Windows integration

An isolated Paper 26.3 installation used the real Velocity 4.3.1-45 gateway,
EaglerXServer 1.1.1, pinned Via translators and a Cloudflare WSS tunnel. The
NodePilot companion was refreshed to 0.1.2 without replacing third-party files.

- A 26.3/EaglerX-v5 connection with no authentication capability or password
  completed login, received world chunks and position, sent movement packets,
  and reconnected with its original UUID.
- A legacy 1.8 connection did the same, including an unprefixed profile name
  mapped to the existing prefixed browser account.
- After stopping Minecraft and switching passwords back on through the real
  API, an incorrect password was denied and the existing account completed the
  same 26.3 world-loading/reconnect checks.
- Native Java probes retained their online-authentication challenge in both
  modes, and direct connections to the private backend were rejected.

These are server/protocol checks, not a claim of graphical gameplay in every
third-party browser client or of a live Linux game session. Browser compatibility
remains experimental. The repeatable protocol helper accepts
`requirePassword: false` in its private test configuration for open mode.

Automated tests cover API input/confirmation validation, stopped-server exclusion,
persisted mode checks on stale listeners, scoped verifier tokens, stable identities,
revocation, collision protection and conversion to password accounts. The compiled
API tests, companion compilation/password codec tests, TypeScript checks and
production build pass locally. Browser-flow tests exercise changing both modes
and the existing setup/account/retry controls, plus unavailable and running states.
The complete Windows suite passes 266 tests with one Linux-only skip.
