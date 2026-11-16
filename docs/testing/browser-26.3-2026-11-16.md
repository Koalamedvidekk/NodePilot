# Browser Players 26.3 verification

The previous integration limited backends to 1.19–1.21.11. Its pinned Velocity
3.4.0 could translate a legacy Eaglercraft connection to Paper 26.3, but a protocol
777/v5 connection subsequently received older packet IDs. Removing the version
check alone was insufficient.

New setups pin official Velocity 4.3.1 build 45 with its published SHA-256,
EaglerXServer 1.1.1, ViaVersion/ViaBackwards 5.12.2 and ViaRewind 4.2.0. The
gateway requires Java 25. The NodePilot authentication companion compiles against
that Velocity artifact and retains channel-bound identity verification. Existing
configured gateways are retained; their status explains re-setup for modern clients.

Stable mappings come from the pinned [ViaVersion protocol table](https://github.com/ViaVersion/ViaVersion/blob/5.12.2/api/src/main/java/com/viaversion/viaversion/api/protocol/version/ProtocolVersion.java):
26.1/26.1.1/26.1.2 use 775; 26.2 uses 776; 26.3 uses 777. Unknown patches and
snapshots remain unavailable. The EaglerX protocol-v5 maximum is explicitly 777.

## Real Windows checks

A fresh temporary installation downloaded real Paper 26.3 and the managed gateway
components. No existing user server, tunnel or account was used. A temporary
Cloudflare WSS tunnel reached only the game gateway. Isolated test accounts used
NodePilot's salted password storage and the real authentication companion.

Both the 1.8 and 26.3/v5 protocol clients completed password authentication,
received world chunks and position data, sent movement, and reconnected with the
same stored UUID. Incorrect passwords were denied, ordinary Java connections
received an online-authentication challenge, and direct backend login was rejected.
The 26.3 test completes native configuration, registry-pack negotiation, teleport
acknowledgement, player-loaded and chunk-batch replies. Its packet IDs come from
ViaVersion's [26.3 packet definitions](https://github.com/ViaVersion/ViaVersion/tree/5.12.2/common/src/main/java/com/viaversion/viaversion/protocols/v26_2to26_3/packet).
The changed AcceptTeleportation payload was verified against the actual unmodified
26.3 server codec: it carries the teleport ID, coordinates and rotation.

These are real server/protocol tests. A graphical 26.3 client session was attempted
but did not complete: the streamed client failed to fetch its sound archive, and
the self-contained attempt ended when the test browser closed. No graphical
gameplay, every third-party client, or live Linux
game session is claimed. The panel continues to label browser compatibility
experimental and requires an EaglerX-v5 client with a configurable profile name.

To repeat the protocol checks, run `scripts/test-browser-gameplay.mjs` after a
build, pointing `NODEPILOT_BROWSER_TEST_CONFIG` to a private JSON file containing
`publicAddress`, `name`, `password`, `expectedUuid`, `serverPort`, `backendPort`,
and `backendProtocol`. Add `clientProtocol: 777` for 26.3/v5; omit it for 1.8.
The script never prints credentials or authentication packets. Use an isolated
server whose EULA is explicitly accepted and whose whitelist permits the test name.

Automated coverage includes stable-version availability, future-version rejection,
native backend protocol configuration, bounded v5 negotiation, old-gateway upgrade
guidance, authentication, ownership checks, rollback, recovery and Auto-Wake.
The local Windows full suite passed 261 tests, with one Linux-only skip; TypeScript,
production build, compiled Browser Players API and companion compilation passed.
