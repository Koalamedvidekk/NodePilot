# Server template verification for v0.1.27

## Local automated checks

- Type checks and production build passed.
- The complete Windows suite passed 247 tests; one Linux-only test was skipped.
- New service tests cover software/version compatibility, isolated preset defaults,
  numeric encodings before 1.14, exact signed seeds, malicious overrides, Hardcore
  constraints, real configuration writes, and unchanged ordinary creation.
- A separate compiled Fastify instance verified authenticated catalogue/version
  routes, invalid requests before any server creation, all four preset creations,
  and persistence of later edits across panel restart. Its downloads and Java
  discovery use explicit fixtures.
- Playwright drove that real backend: template and version selection, customized
  creation, EULA acceptance, property-file verification, Hardcore locks/reset,
  mobile card bounds, and switching between Custom/Java/Bedrock creation. No
  browser API requests were intercepted. Download/runtime fixtures are not
  presented as playable servers.

## Actual Minecraft runs on Windows

An additional fresh temporary installation used real upstream metadata/downloads,
Java processes, HTTP lifecycle requests, console readiness, and saved world reads.
Only global Playit discovery was disabled to leave the user's tunnel untouched.

| Template | Software/version | Runtime | Verified after first start and stop |
| --- | --- | --- | --- |
| SMP | Paper 1.21.4 | Java 25 | Survival, Normal difficulty, non-Hardcore world |
| Creative | Mojang Vanilla 1.12.2 | Java 8 | Creative, Peaceful difficulty, legacy property encodings |
| Hardcore | Mojang Vanilla 26.3 | Java 25 | Survival, Hard difficulty, saved Hardcore flag |

Each creation stayed stopped until an explicit start. All three reached Minecraft's
`Done` message, stopped cleanly, and saved the exact seed `-9223372036854775808`.
This verifies configuration, generation and lifecycle, not multiplayer gameplay or
every historical Minecraft/software combination. Live Linux Minecraft processes
were not exercised locally; the release workflow covers the Linux automated suite
and browser checks before publishing.
