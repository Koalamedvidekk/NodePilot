# NodePilot browser gateway companion

NodePilot installs this Velocity plugin alongside EaglerXServer 1.1.1.
Browser players join with their client name. NodePilot uses the same
server-specific profile and UUID whenever they return with that name.
Velocity continues to sign in Java players through its normal online login.

The managed proxy loads `plugins/nodepilot-browser-auth/config.json`. NodePilot
supplies the server ID, the loopback profile endpoint URL, and a scoped token used
between the proxy and NodePilot. The endpoint accepts the player name and returns
the stored name and UUID. The companion assigns that profile to the originating
EaglerX connection. NodePilot waits for `NODEPILOT_BROWSER_GATEWAY_READY` before
it opens the public game tunnel.

## Build

Run this from the repository root with Node.js and JDK 25 or newer on PATH.

```sh
node companion/nodepilot-velocity-auth/build.mjs
```

Use `--check` to compile without changing the bundled artifact. The script
verifies the pinned Velocity and EaglerXServer dependencies against their
SHA-256 values, then generates a JAR containing NodePilot's code. It embeds
the JAR and checksum in `server/services/browser-auth-artifact.ts`.

## Live integration check

Build NodePilot and enable Browser Players on a dedicated Paper 26.3 server.
Point `NODEPILOT_BROWSER_TEST_CONFIG` to a local JSON file containing
`publicAddress`, `name`, `serverPort`, `backendPort`, `backendProtocol: 777`,
and `clientProtocol: 777`. For a migrated profile, add `expectedName` and
`expectedUuid` to check its original identity.

```sh
node scripts/test-browser-gameplay.mjs
```

The test uses Node.js 22 or newer to connect over WSS, load world chunks, send
movement packets, reconnect with the same UUID, and check the Java proxy and
private backend boundaries.
