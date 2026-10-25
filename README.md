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

- Node.js **20.19 or later** (Node 22 LTS is automatically installed on startup if missing).
- A Java runtime compatible with the selected Minecraft version. NodePilot scans `JAVA_HOME`,
  the system path, and common installation locations, then reports discovered versions.
  Modern Minecraft versions normally require Java 17 or Java 21; NodePilot can automatically download and install Eclipse Adoptium OpenJDK (Java 8, 11, 16, 17, 21, 25).
  if the required runtime is not already installed on your system.
- An internet connection only while fetching version metadata and downloading a server JAR.
- **Git on PATH for Spigot only.** Its official BuildTools compiles the selected release locally,
  so it can take longer than direct server downloads.

## Install and run

### Quick Start (Automatic Setup)

#### Windows
Simply clone or download the ZIP, then run `start.bat` (or double-click it in Windows):
```powershell
git clone https://github.com/Koalamedvidekk/NodePilot.git
cd NodePilot
.\start.bat
```
> If Node.js is not installed on your system, `start.bat` will automatically download and set up Node.js LTS for you!

Or install directly via a one-line PowerShell command:
```powershell
irm https://raw.githubusercontent.com/Koalamedvidekk/NodePilot/main/install.ps1 | iex
```

#### Linux & macOS
```bash
git clone https://github.com/Koalamedvidekk/NodePilot.git
cd NodePilot
chmod +x start.sh
./start.sh
```
> If Node.js is missing, `start.sh` automatically downloads and configures the official Node.js LTS binary package.

### Manual Setup

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

## Updating NodePilot

Open **Host Settings → NodePilot Updates** to see the installed version, check
GitHub Releases, choose whether preview releases are included, and review release
notes. For a packaged NodePilot installation, **Install & Restart** only appears
when all of these conditions are met:

- The release contains the expected versioned universal ZIP package and its
  matching SHA-256 file.
- The downloaded archive matches that published SHA-256 value.
- The archive has no unsafe paths, links, duplicate paths, or unlisted files.
- No NodePilot-managed game server is running.

The updater stages and builds the release before restarting, keeps the NodePilot
data directory (worlds, database, and backups) and the environment file untouched,
and records its result in the updates log inside the data directory. It does not
force-kill NodePilot if graceful shutdown takes too long.

Git checkouts intentionally do **not** auto-install releases, because an updater
must never overwrite local source changes. Update a clone with:

    git pull --ff-only
    npm ci
    npm run build

## Configuration and data

When running for the first time, NodePilot offers an interactive setup wizard in your terminal to choose whether you want to run locally on your PC or make NodePilot accessible to other devices on your local Wi-Fi / LAN network. You can run or re-run this anytime with:

```bash
npm run setup
```

You can also copy `.env.example` to `.env` to configure settings manually:
- `NODEPILOT_HOST=127.0.0.1` binds exclusively to your local machine.
- `NODEPILOT_HOST=0.0.0.0` enables LAN mode, allowing you to access the dashboard and control Minecraft servers from other laptops, PCs, or phones on the same Wi-Fi.
- `NODEPILOT_PORT=7420` specifies the web panel port.
- `NODEPILOT_PIN=1234` (optional) protects LAN access with a PIN code.
- `NODEPILOT_DATA_DIR` overrides the directory where server instances and SQLite catalogue data are stored (defaults to `.nodepilot/`).

By default NodePilot keeps its SQLite catalogue and managed server directories under `.nodepilot/` in the project directory. That directory is ignored by Git. Back it up to preserve worlds and configuration.

## 🌐 Running on an Old Laptop or Dedicated Home Server (LAN Remote Control)

Have an old laptop or desktop sitting around? You can turn it into a dedicated Minecraft server host and manage it seamlessly from your main PC or laptop over your home Wi-Fi:

1. **Setup on the old laptop**:
   - Clone the repository and install dependencies (`npm install && npm run build`).
   - Run `npm run setup` and choose **Visible on Local Network / LAN (0.0.0.0)**.
   - Optionally set an access PIN to keep your dashboard protected on shared networks.
   - Run `npm start`. NodePilot will print your direct LAN access URLs:
     ```
     ========================================================================
       🚀 NodePilot is ready!
       Local access:   http://localhost:7420
       Network access: http://192.168.1.150:7420
       Mode:           Visible on Local Network (0.0.0.0)
     ========================================================================
     ```

2. **Control from your main laptop / phone**:
   - Make sure your main device is connected to the same Wi-Fi or router.
   - Open `http://<laptop-ip>:7420` (e.g. `http://192.168.1.150:7420`) in any web browser.
   - Enter your PIN if configured, and you have complete control over all game servers, live consoles, file management, and performance monitoring.

3. **Playing Minecraft on LAN**:
   - Minecraft servers started through NodePilot bind to all network interfaces.
   - Players on your home network can connect in Minecraft using the old laptop's local IP and the server's configured port (e.g. `192.168.1.150:25565`).

4. **Change modes anytime in the web panel**:
   - Click the **Local mode / LAN mode** pill in the top header or the host card in the sidebar footer to open the **Network & Remote Access** modal.
   - View your detected IP addresses, copy URLs with 1 click, switch between Local and LAN modes, or update your PIN without restarting manually.

## Private remote panel access with Tor

NodePilot can optionally make **the web panel only** available through a private
Tor Onion address. This is useful when you want to manage the host from outside
your home network without port forwarding, a public relay, an account, or a
mandatory paid service. It is not intended for Minecraft player traffic.

1. Set an **Access PIN** of at least 4 characters in **Network & Remote
   Access**. NodePilot refuses to enable Tor without one, and it will not allow
   the PIN to be removed while private access is running.
2. In **Host Settings**, open **Private Remote Access (Tor)** and choose
   **Install Tor (1-Click)**. NodePilot downloads the latest compatible stable
   **Tor Expert Bundle** from the official Tor Project, verifies the bundle
   against Tor Project's signed SHA-256 manifest and pinned signing-key
   fingerprint, then installs it only inside NodePilot's data directory.
   Existing system or Tor Browser installations are also detected and used.
3. NodePilot starts private access automatically after that if a valid PIN is
   already configured; otherwise choose **Enable Private Access** after setting
   the PIN. It creates a persistent Onion key under its local data directory and
   displays the resulting `http://…onion` URL.
4. Open that URL in [Tor Browser](https://www.torproject.org/download/) on the
   computer or phone you are using remotely, then enter the same NodePilot panel
   PIN. The Expert Bundle installed by NodePilot is the local Tor service, not a
   web browser.

The Onion address and the opt-in setting persist over ordinary NodePilot restarts
and application updates; after the panel is listening, NodePilot restores the
local Tor service automatically when the panel PIN is still configured. **Reset
Address** intentionally destroys that local Onion identity, so the old address
will no longer work. If Tor is installed somewhere unusual, set
`NODEPILOT_TOR_PATH` to the absolute path of the `tor` executable before starting
NodePilot. The managed Tor configuration listens on no SOCKS port and forwards
only the panel's local `127.0.0.1` port. One-click installation currently
supports Windows and Linux x64; other platforms can use an existing Tor
installation.

## ⚙️ Host Settings & System Startup (Boot Automation)

NodePilot includes full host integration to run in the background on your PC or home server:

1. **System Startup**:
   - Open **Host Settings** from the sidebar navigation (`/settings`).
   - Click **Enable Startup** to configure automatic boot startup.
   - On **Windows**: Creates a per-user startup entry (`NodePilot-Startup.vbs`) requiring zero administrator privileges. Choose between **Headless** (silent background operation) and **Windowed** modes.
   - On **Linux**: Installs and enables a user systemd service (`~/.config/systemd/user/nodepilot.service`).
   - Optionally toggle **Open Browser on Startup** to automatically launch your default browser to NodePilot when the host boots.

2. **Per-Server Auto-Start**:
   - In **Host Settings**, toggle any server between **Always Start** and **Leave Stopped**.
   - Marked servers start automatically and cleanly once NodePilot boots up.
   - Auto-start coordinates with **Playit.gg** so public tunnel readiness and Minecraft server readiness are handled seamlessly.

3. **Background Persistence**:
   - NodePilot runs as an independent daemon. Closing your browser tab or window never terminates your running Minecraft servers.

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
- Self-updates use a fixed GitHub Release asset name, require a matching SHA-256
  checksum, manually restrict redirects to GitHub-owned HTTPS hosts, and inspect
  the ZIP before any application files are changed.
- The detached updater never kills its parent PID; it waits for a graceful close,
  preserves local data and environment files, and rolls back application files if
  dependency installation or the build fails.
- Usage metrics are collected only for child processes NodePilot started in this session; an old
  process ID is never rediscovered after a restart.
- File editing is limited to supported text files and size-capped; binary JARs and
  directory escapes cannot be overwritten through the API.
- Deletion refuses running servers and only removes the server directory recorded
  for that catalogue entry.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run setup` | Run interactive setup wizard to configure network access (Local vs LAN) and PIN. |
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

