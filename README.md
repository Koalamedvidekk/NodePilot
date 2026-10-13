# NodePilot

NodePilot is a free, local-first game server manager for Windows and Linux. It
runs on your own computer and opens a browser panel at
`http://127.0.0.1:7420` by default—no Docker, account, cloud service, or
mandatory telemetry required.

> NodePilot is not affiliated with Mojang, Microsoft, or PaperMC. Minecraft is
> a trademark of Microsoft Corporation.

## What it does

- Shows actual host status plus process-only usage for each managed running server.
- Creates Minecraft: Java Edition servers for Vanilla, Paper, Spigot, Purpur, Fabric, Forge,
  NeoForge, and Quilt from trusted upstream metadata.
- Downloads or installs the selected software using its publisher-supported workflow, verifies
  publisher checksums where available, creates the server directory, and writes a safe starter
  configuration.
- Requires explicit Minecraft EULA acceptance for every new server.
- Starts, stops, restarts, and deletes servers without shell interpolation.
- Lets you change a stopped server's maximum Java heap from its management page.
  NodePilot starts the JVM with a smaller heap (512 MB to 1 GB, depending on the
  configured maximum) so an idle server does not reserve its full limit up front.
- Streams process output through a WebSocket console and accepts console commands.
- Provides a Usage tab with managed-process CPU, RSS, Java heap where `jcmd` is available,
  process I/O, managed-directory size, uptime, and bounded rolling charts. It never shows
  whole-machine usage as though it belonged to one server.
- Lets you edit `server.properties` as structured key/value data and browse/edit text files
  inside a server directory without escaping it.
- Imports existing server folders and ZIP archives into a new managed copy while preserving the
  original, worlds, player data, configuration, plugins, mods, and recognized loader launch files.
- Keeps plugin and mod workflows separate, backs up add-ons before change, and supports
  Modrinth plus Hangar for compatible Paper/Purpur plugins.
- Stores the server catalogue in SQLite and marks previously-running processes stopped on
  application recovery (it never silently starts game processes after a restart).

## Requirements

- Node.js **20.19 or later** (Node 22 LTS is a good choice).
- A Java runtime compatible with the selected Minecraft version. NodePilot scans `JAVA_HOME`,
  the system path, and common installation locations, then reports discovered versions.
  Modern Minecraft versions normally require Java 17 or Java 21; the creation screen surfaces
  compatibility before a server is started.
- An internet connection only while fetching version metadata and downloading a server JAR.
- **Git on PATH for Spigot only.** Its official BuildTools compiles the selected release locally,
  so it can take longer than direct server downloads.

## Install and run

### Windows (PowerShell)

```powershell
git clone https://github.com/Koalamedvidekk/NodePilot.git
Set-Location NodePilot
npm install
npm run build
npm start
```

Open <http://127.0.0.1:7420>. Use `Ctrl+C` in the terminal to stop NodePilot.
For Spigot, install Git for Windows and reopen PowerShell so `git --version` works.

### Linux

```bash
git clone https://github.com/Koalamedvidekk/NodePilot.git
cd NodePilot
npm install
npm run build
npm start
```

Open <http://127.0.0.1:7420> on the same machine.
Install `git` through your distribution package manager before creating a Spigot server.

### Development

```bash
npm install
npm run dev
```

This starts Fastify on `127.0.0.1:7420` and Vite on its displayed development
URL (usually `http://127.0.0.1:5173`). Vite proxies `/api` and WebSocket traffic
to the local backend. For a production-like single-server run, use `npm run build`
then `npm start`.

## Configuration and data

Copy `.env.example` to `.env` if you want to change the default bind host,
port, or data location. The default `NODEPILOT_HOST=127.0.0.1` intentionally prevents
network exposure. If you change it, use a firewall and an authentication proxy;
the initial local-only release does not include multi-user authentication.

By default NodePilot keeps its SQLite catalogue and managed server directories
under `.nodepilot/` in the project directory. That directory is ignored by Git. Back it
up to preserve worlds and configuration.

## Creating a server

1. Visit **Create server** and choose one of the supported server implementations.
2. Select a version fetched from that software's trusted publisher metadata. The chooser only
   presents combinations that NodePilot can verify as available.
3. Choose an available game port and memory limit. NodePilot checks local port
   availability before provisioning.
4. Review the detected Java runtime and accept the Minecraft EULA.
5. Create the server. Once the download completes, use its management page to
   start it, read the live console, send commands, edit properties, or manage files.

| Software | Provisioning workflow |
| --- | --- |
| Vanilla | Mojang version metadata and verified server JAR |
| Paper | Latest stable Paper build from the downloads service, SHA-256 verified |
| Spigot | Official BuildTools, built locally; requires Java and Git |
| Purpur | Official Purpur project API and its upstream integrity value |
| Fabric | Official Fabric metadata and installer, then `fabric-server-launch.jar` |
| Forge | Official Forge Maven installer and generated platform argument files |
| NeoForge | Official NeoForge Maven installer and generated platform argument files |
| Quilt | Official Quilt metadata and installer, then `quilt-server-launch.jar` |

Forge and NeoForge retain their Windows/Linux argument files. Fabric and Quilt use their
launcher JARs. NodePilot validates all managed launcher files before starting Java and never
builds a command through a shell.

### Memory behavior

The maximum-memory field controls Java's `-Xmx` ceiling and can be changed only while a server
is stopped. NodePilot deliberately starts with a smaller `-Xms` value (512 MB to 1 GB, depending
on the configured maximum) so an idle server does not commit its entire heap immediately. Process
memory can still be above Java heap because RSS includes native memory, class metadata, JIT code,
thread stacks, memory-mapped files, and operating-system accounting.

## Usage tab

The **Usage** tab refreshes every two seconds only while it is visible and its managed server is
active. It holds at most 300 in-memory samples (about ten minutes at the normal cadence).

- CPU is the Java process's CPU time normalized against the machine's total logical CPU capacity.
- Memory is that process's resident memory (RSS), not a whole-host value.
- Java heap is queried through the selected Java runtime's `jcmd` tool when that tool is available.
- Disk includes the managed directory size and available per-process read/write rates.
- Network is labelled unavailable unless a reliable per-process collector exists. NodePilot does
  not substitute host-wide network traffic.

NodePilot only keeps a PID while it holds the child process in memory. It never reattaches to a
persisted PID after an application restart, avoiding PID-reuse mistakes.

## Import existing servers

1. Open **Import server**, then select an absolute local directory or ZIP archive.
2. Inspect the source. NodePilot shows detected software/version plus clear warnings for uncertain
   detection, which you may correct before import.
3. Confirm the copy's software, version, port, memory, and explicit EULA acceptance.
4. Import into a new managed directory. The source is copied, never moved, overwritten, or edited.

Imports preserve worlds, player data, configuration, plugins, mods, and recognized loader files.
ZIPs reject traversal, absolute paths, normalized duplicates, links, encrypted entries, suspicious
compression ratios, and unsafe size/count limits. Modern Forge/NeoForge installs with verified
platform argument files can be imported even when no top-level server JAR exists.

## Add-ons and players

- Plugins and mods remain separate: plugin management is for Paper, Spigot, and Purpur; mod
  management is for Fabric, Quilt, Forge, and NeoForge.
- Modrinth searches are checked against the server version and loader. Hangar is limited to
  Paper/Purpur because it publishes Paper-platform plugins. NodePilot backs up add-ons before
  replacement/removal and requires the server to be stopped for add-on changes.
- Basic player actions use Minecraft commands on compatible running servers. Detailed live player
  data and inventory operations require the optional NodePilot Paper bridge; the UI says when a
  capability is unavailable rather than inventing data.

## Architecture

```
React + Vite panel ── /api + WebSocket ── Fastify service ── SQLite catalogue
                                                │
                                  managed Java child processes
                                                │
                                      per-server data directories
```

The backend separates Minecraft provisioning, Java discovery, file management,
and the local process runner. Each saved server also has a `machineId` (currently
always `local`), so future game adapters and remote machine agents can be added
without remapping existing configuration.

## Safety model

- The HTTP service binds to loopback by default.
- Request bodies and route values are schema validated.
- Server IDs are opaque UUIDs; display names are normalized before becoming directory names.
- All managed filesystem access is resolved relative to the selected server root,
  rejecting absolute paths and traversal outside it.
- Java is launched using argument arrays, never by concatenating user text into a shell command.
- Publisher downloads are restricted to fixed HTTPS hosts, size limited, redirect-checked, and
  verified against publisher checksums whenever the upstream provides one.
- Usage metrics are collected only for child processes NodePilot started in this session; an old
  process ID is never rediscovered after a restart.
- File editing is limited to supported text files and size-capped; binary JARs and
  directory escapes cannot be overwritten through the API.
- Deletion refuses running servers and only removes the server directory recorded
  for that catalogue entry.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the backend and Vite development server together. |
| `npm run dev:server` | Run only the TypeScript Fastify backend. |
| `npm run dev:client` | Run only the Vite frontend. |
| `npm run build` | Type-check and build both workspaces. |
| `npm start` | Start Fastify, including the built browser panel. |
| `npm run check` | Run TypeScript checks for both workspaces. |
| `npm test` | Run server unit tests, import safety checks, and process-metric tests. |

## Upstream references

- [Paper downloads service](https://docs.papermc.io/misc/downloads-service/)
- [Fabric server installation](https://fabricmc.net/use/?page=server)
- [Quilt server installation](https://quiltmc.org/en/install/server/)
- [NeoForge server installation](https://docs.neoforged.net/user/docs/server/)

## License

NodePilot is released under the [MIT License](LICENSE).

