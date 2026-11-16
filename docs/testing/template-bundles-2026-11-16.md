# Template bundle verification for v0.1.28

## Automated verification

Local Windows type checks and production build passed. The complete local suite
passed 258 tests, with one Linux-only test skipped. The release workflow also
runs Windows template tests and compiled API checks, plus the Linux full suite
and real browser-to-backend flows before publishing.

Eleven bundle service tests cover stable version intersections, pinned dependency
versions, conflicts/cycles, client requirements, missing checksums, case collisions,
current Hangar size/checksum metadata, staged installation and registry tracking,
restricted permissions, failed commit rollback, cached retries, durable recovery,
external-edit preservation, cancellation, expired/stale previews and low disk space.

`node scripts/test-server-templates.mjs --bundles --ui` uses an isolated Fastify
backend, SQLite and filesystem, with explicit upstream/Java fixtures. Browser API
requests are not intercepted. It verifies authenticated previews, idempotent and
concurrent creation, maintenance exclusion, failure/retry/cancel endpoints,
automatic initial version selection, preservation of explicit incompatible choices,
catalogue selection/removal, review and tracked installation in Plugins. Existing
Custom/Pure Vanilla/Hardcore/Bedrock creation and mobile bounds are retained.

The live Hangar API was additionally checked with `pop4959/Chunky`: a compatible
Paper 1.21.4 release resolved with its published `sizeBytes` and `sha256Hash`.
External-link-only Hangar releases remain unavailable for automatic installation.

## Actual Minecraft runs

A separate temporary installation used real metadata, verified publisher files,
Java 21, fresh generated worlds, and ephemeral loopback game ports. Only global
Playit discovery was disabled to preserve the user's tunnel. Game authentication
was asserted enabled after installation, then disabled solely in these isolated
QA worlds for protocol-client testing; all original properties were retained.

| Software | Minecraft | Actual add-ons | Observed result |
| --- | --- | --- | --- |
| Paper | 1.21.4 | EssentialsX 2.21.0; LuckPerms 5.5.71 Bukkit | Loaded, joined, moved, loaded chunks and reconnected. Non-operators used `/sethome`, `/msg`, `/tpa` and `/tpaccept`; administrative commands did not grant OP or Creative. |
| Purpur | 1.21.4 | EssentialsX 2.21.0; LuckPerms 5.5.71 Bukkit | Same plugin, connection and permission checks passed. |
| Fabric | 1.21.4 | Lithium 0.15.3 Fabric; FerriteCore 7.1.3 Fabric | Both mods loaded. An unmodified-protocol client loaded chunks, moved and reconnected. |
| NeoForge | 1.21.4 | Lithium 0.15.3 NeoForge; FerriteCore 7.1.3 NeoForge | Both mods loaded. A vanilla-branded protocol client loaded chunks, moved and reconnected. |

All four installations remained stopped until explicit start, registered their
add-ons with exact provider/version IDs, stopped cleanly, and saved the seed
`-9223372036854775808` exactly. Basic permissions were also checked through the
real LuckPerms permission resolver. bStats configuration was written disabled.

The optional `scripts/test-template-bundles-live.mjs` reproduces these checks with
`minecraft-protocol` supplied through `NODEPILOT_MINECRAFT_PROTOCOL_MODULE`.
It sends normal vanilla configuration replies, ping/pong, brand, teleport
confirmations and chunk acknowledgements. Its stationary clients use a temporary
platform so teleport safety is not confused with missing gravity simulation.

These are server/protocol tests, not graphical-client or human gameplay sessions.
Live Minecraft processes were verified locally on Windows; live Linux Minecraft
sessions and every historical publisher combination were not exercised locally.
Other offered versions depend on the publishers' compatibility metadata and are
still validated again through downloaded JAR inspection before installation.
