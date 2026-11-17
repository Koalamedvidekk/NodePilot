# NodePilot browser authentication companion

NodePilot installs this Velocity plugin with its managed browser gateway. It requires
EaglerXServer 1.1.1 and the local NodePilot verification endpoint. Ordinary Java
connections retain Velocity's online authentication.

By default the plugin requests an Eaglercraft password and verifies it through a
scoped loopback HTTP endpoint. Owners can explicitly select open access in the
panel: the plugin then skips the password challenge and resolves the player's
stable, server-scoped identity through the separate `/open` verifier endpoint.
Revoked and conflicting reserved identities remain denied. Open access does not
prove ownership of a player name; use a server login plugin if desired.
The public WebSocket connection must use WSS, or local WS
for testing. NodePilot's HTTP gateway supplies the secret header required by the
Eagler listener. Cookie authentication and nickname selection are disabled.
Failed verification, missing configuration and unavailable NodePilot services deny
browser login.

## Build

Run this from the repository root with Node.js and a JDK 25 or newer on PATH.

```sh
node companion/nodepilot-velocity-auth/build.mjs
```

Use `--check` to compile and run the password-decoding regression without changing
the bundled artifact.

The script downloads the pinned Velocity and EaglerXServer compile dependencies,
checks their SHA-256 values, then compiles NodePilot's source. It generates
`server/services/browser-auth-artifact.ts` with the JAR and its checksum. Users
installing NodePilot receive this built artifact and do not need a Java compiler.
Upstream classes are provided at runtime and are excluded from the companion JAR.

The plugin reads `plugins/nodepilot-browser-auth/config.json` in the managed
proxy directory. NodePilot supplies `serverId`, `verifyUrl`, `token`, and
`requirePassword` (defaults to true when absent).
The verifier URL must be literal loopback HTTP with an explicit port. Its POST
body contains `name` and `password`, with the scoped token in a Bearer header.
An approved response contains `ok`, `name`, and `uuid`.
Open-mode verification contains only `name` and uses the same scoped token.

`NODEPILOT_BROWSER_AUTH_READY` is emitted only after configuration validation and
authentication handler registration. NodePilot waits for this marker before
opening the public game tunnel.

## Live integration check

After building NodePilot, use a dedicated Paper 1.21.4 test server with Browser
Players enabled. Store a private JSON file outside the checkout with
`publicAddress`, `name`, `password`, `expectedUuid`, `serverPort`, `backendPort`,
and `backendProtocol`. Use the actual browser account UUID from NodePilot and
Minecraft protocol `769` for the backend. Set `NODEPILOT_BROWSER_TEST_CONFIG` to
that file and run the integration check.

```sh
node scripts/test-browser-gameplay.mjs
```

The check negotiates the Minecraft 1.8 browser protocol through the real gateway.
It verifies rejected passwords, the stored UUID, world chunks, position and
movement packets, reconnects, the native Java authentication challenge, and
rejection of direct backend login. The supplied credentials are never printed.
The test requires Node.js 22 or newer and does not start or stop the game server.
Set `requirePassword: false` to test a client that advertises no authentication
capability and sends no password. Add `clientProtocol: 777` for 26.3/v5 and use
`backendProtocol: 777` when the test server runs Paper 26.3.
