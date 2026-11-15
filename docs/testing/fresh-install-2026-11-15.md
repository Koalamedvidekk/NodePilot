# Fresh-install verification for v0.1.24

The public v0.1.23 universal release was downloaded into a new temporary directory,
its SHA-256 verified, and started with `start.bat`. It installed its own npm
dependencies and built the application. The test installation used a separate
data directory, SQLite database and localhost port. Fixes were built into that
installation and each observed failure was retested against the running backend.
No existing game servers were used.

## Observed failures corrected

- Paper's `.paper-remapped` runtime JARs blocked automatic Minecraft upgrades and
  inflated the plugin count during import. Only actual loader entry points and
  pending Bukkit updates are counted.
- Bukkit's generated world datapack was removable. Paper, Purpur and Spigot now
  protect its files and selection as software-managed content.
- Minecraft 26.3 stores hardcore inside `difficulty_settings`. Reading and writing
  that flag now uses the saved layout and retains legacy compatibility.
- Live inventory changes reached Paper, but player details silently fell back to
  saved data because the `players.get` request did not match the companion plugin's
  player-reference format. Live details now use the same contract as actions.
- Client-only mods were offered and installed as server-compatible. Modrinth side
  support and Fabric/Quilt environment declarations are checked before deployment.
- An Auto-Wake listener could make ViaVersion learn a browser client's protocol
  while Minecraft was asleep, causing an outdated-client rejection after startup.
  The managed proxy now pins the backend protocol for the selected release.
- ZIPs without explicit directory entries hid their worlds during inspection.
  ZIP inspection now derives worlds from their metadata paths and safely inspects
  a bounded, staged server JAR to identify generic `server.jar` archives.
- The production dependency lock was refreshed to remove the three advisories
  reported during the fresh install. The Tor PIN-removal error now explains that
  private access must be disabled first.

## Runtime checks

These used real downloads, Minecraft processes, HTTP requests and browser controls:

| Area | Observed result |
| --- | --- |
| Installation | Release checksum, dependency installation, native SQLite, production build and `start.bat` launch passed on Windows. |
| Dashboard | Empty and populated fleet views, host readings and managed Java CPU/RSS/heap/disk measurements worked. |
| Creation | Paper 1.21.4, Vanilla 26.3 and Fabric 1.21.4 downloaded and started. Missing EULA acceptance and occupied ports were rejected. |
| Lifecycle | Start, stop, restart, WebSocket console, commands and persistence across panel restarts worked. |
| Files | File/folder creation, UTF-8 editing and reading worked. Read/write traversal and a foreign-browser-origin mutation were blocked. |
| Imports | A 290-file server directory and its ZIP imported into independent copies. Source files and archive remained unchanged; copied content matched except intentionally rewritten server configuration. |
| Missing directory | A catalogue entry with its game directory moved aside could still be deleted. The preserved directory remained intact. |
| Worlds | Preparation left Minecraft stopped; generation occurred on start. Both signed 64-bit seed extremes were read exactly. Grouped ZIP export/import, backups, restore, confirmed deletion and restoration of a deleted world worked. |
| Player isolation | A real test player had separate inventories and XP in two saved worlds. Returning to the original world restored its original items, XP and location. |
| Modern layouts | Actual Vanilla 26.3 and upgraded Paper 26.3 worlds were read. Hardcore changes survived a real Vanilla restart, and modern Paper saved player data was readable. |
| Players | A Minecraft protocol client exercised OP/de-OP, kick, ban/unban, game mode and teleport. The built Paper companion connected and supplied live health, XP, location and inventory; healing, replacing and clearing inventory slots took effect. |
| Plugins/mods | LuckPerms installed from Modrinth while running stayed queued until restart. Queue cancellation and removal worked. Fabric API installed and ran. Plugin/mod mismatches and client-only catalogue/upload attempts were rejected. Hangar search returned real results. |
| Minecraft updates | Opting in upgraded stopped Paper from 1.21.4 to 26.3, retained identical world-file hashes and created a full backup. The upgraded server started and saved a modern Paper world. |
| Browser Players | Official gateway components downloaded and passed checksum verification; setup, account creation, password reset, revocation and disable/restore worked. A real public WSS protocol client received the Auto-Wake notice, loaded world data, exchanged movement packets and reconnected with its stable UUID. Wrong, reset and revoked passwords were rejected. The tunnel did not expose the panel API. |
| PIN/Tor | A fresh browser showed the unlock dialog; a four-character PIN worked. Through an independent Tor client, the real Onion service returned 401 without the PIN and 200 with it. Removing the PIN while Tor was active was blocked; stopping private access worked. |
| Layout | Loaded Worlds, Files and Versions pages stayed within a 390-pixel viewport; mobile navigation opened and closed. |

## Automated checks

- Local Windows suite: **239 passed, 1 skipped, 0 failed**. The skip is the
  Linux-only update-helper test.
- Type checks and the production build passed.
- Compiled Versions, Worlds, queued add-ons, imports and Browser Players API
  scripts passed.
- `npm audit --omit=dev` reported zero vulnerabilities.
- The release workflow verifies Windows and Linux before publishing. It now also
  runs the player-detail and mod-descriptor regressions explicitly on Windows.

## Scope

The browser-game check used an Eaglercraft 1.8-compatible protocol client, not a
fully rendered browser game or a 1.12.2 client. Browser support remains experimental.
Linux runtime interaction was not repeated manually on this Windows host; Linux
checks run in CI. Existing OS startup registration and Playit account credentials
were left unchanged. Fresh OS installations without Java/Tor, authenticated
Microsoft player logins, and arbitrary third-party modpacks were not manually
exercised. A real packaged self-update is checked after the release is published.
