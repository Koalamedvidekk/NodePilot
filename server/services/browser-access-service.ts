import { spawn, type ChildProcess } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import type { SqliteDatabase } from "../db.js";
import { AppError, errorMessage } from "../lib/errors.js";
import {
  GameConnectionResolver,
  type BrowserConnectionPorts,
} from "../lib/game-connections.js";
import {
  parseJavaProperties,
  patchJavaProperties,
} from "../lib/java-properties.js";
import { resolveManagedServerRoot } from "../lib/paths.js";
import { minecraftReleaseProtocol } from "../lib/minecraft-protocol-version.js";
import { BrowserAccountRepository } from "../repositories/browser-account-repository.js";
import type { ServerRepository } from "../repositories/server-repository.js";
import type { ServerRecord } from "../types.js";
import type { JavaService } from "./java-service.js";
import { BrowserDependencyService } from "./browser-dependencies.js";
import {
  patchYaml,
  browserConfigurationPath,
  readConfiguration,
  restoreSettings,
  writeConfiguration,
  type BrowserFileChange,
  type OwnedSetting,
} from "./browser-configuration.js";

type Log = { timestamp: string; message: string };
type Installed = Awaited<ReturnType<BrowserDependencyService["install"]>>;
interface Preview {
  revision: string;
  changes: string[];
  warnings: string[];
}
interface BrowserRecord {
  configured: boolean;
  enabled: boolean;
  backendPort: number;
  wakePort: number;
  gatewayPort: number;
  authPort: number;
  javaPath: string;
  installed: Installed | null;
  bridgeToken: string;
  forwardingToken: string;
  gatewayToken: string;
  owned: OwnedSetting[];
  files: BrowserFileChange[];
  preview: Preview | null;
  journal: { kind: "setup" | "disable"; changes: BrowserFileChange[] } | null;
  recoveryError: string | null;
}
interface Operation {
  phase: string;
  progressPercent: number | null;
  error: string | null;
  logs: Log[];
}
interface Running {
  probe?: AbortController;
  children: ChildProcess[];
  http: HttpServer[];
  aliases: Map<number, net.Server>;
  sockets: Set<net.Socket>;
  publicAddress: string | null;
  stopping: boolean;
}
export interface BrowserAccessOptions {
  dataDirectory: string;
  serversDirectory: string;
  assertMaintenance: (id: string) => void;
  isProcessActive: (id: string) => boolean;
  wakePort?: (server: ServerRecord) => number | null;
}

async function availablePort(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", () =>
      reject(
        new AppError(
          409,
          "browser_port_in_use",
          `Game gateway port ${port} is occupied. Stop the conflicting application and retry.`,
        ),
      ),
    );
    listener.listen(port, "0.0.0.0", () => {
      const selected = (listener.address() as net.AddressInfo).port;
      listener.close((error) => (error ? reject(error) : resolve(selected)));
    });
  });
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function equalToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Owns only gateway processes launched by this instance. No persisted PID is ever killed. */
export class BrowserAccessService {
  readonly accounts: BrowserAccountRepository;
  readonly connections: GameConnectionResolver;
  private readonly operations = new Map<string, Operation>();
  private readonly busy = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly running = new Map<string, Running>();
  private readonly launches = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly servers: ServerRepository,
    private readonly java: JavaService,
    private readonly options: BrowserAccessOptions,
    private readonly dependencies = new BrowserDependencyService(
      options.dataDirectory,
    ),
  ) {
    database.exec(
      `CREATE TABLE IF NOT EXISTS browser_access (server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE, payload TEXT NOT NULL)`,
    );
    this.accounts = new BrowserAccountRepository(database);
    this.connections = new GameConnectionResolver((id) => this.ports(id));
  }

  private record(id: string): BrowserRecord | null {
    const row = this.database
      .prepare("SELECT payload FROM browser_access WHERE server_id=?")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as BrowserRecord) : null;
  }
  private save(id: string, record: BrowserRecord): void {
    this.database
      .prepare(
        "INSERT INTO browser_access(server_id,payload) VALUES(?,?) ON CONFLICT(server_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(id, JSON.stringify(record));
  }
  ports(id: string): BrowserConnectionPorts | null {
    const record = this.record(id);
    return record?.configured ? record : null;
  }
  isEnabled(id: string): boolean {
    return this.record(id)?.enabled === true;
  }
  isBusy(id: string): boolean {
    return this.busy.has(id);
  }
  anyBusy(): boolean {
    return this.busy.size > 0;
  }
  assertPortNotReserved(port: number): void {
    for (const server of this.servers.list()) {
      const record = this.record(server.id);
      if (
        record?.configured &&
        [
          record.backendPort,
          record.wakePort,
          record.gatewayPort,
          record.authPort,
        ].includes(port)
      )
        throw new AppError(
          409,
          "browser_port_reserved",
          "This port is reserved by a browser gateway. Choose another port.",
        );
    }
  }
  hasRecoveryBlock(id: string): boolean {
    const record = this.record(id);
    return Boolean(record?.journal || record?.recoveryError);
  }
  assertCanStart(id: string): void {
    if (this.isBusy(id))
      throw new AppError(
        409,
        "browser_operation_in_progress",
        "Wait for Browser Players setup to finish.",
      );
    if (this.hasRecoveryBlock(id))
      throw new AppError(
        409,
        "browser_recovery_required",
        "Browser Players configuration needs recovery before starting this server.",
      );
  }
  assertCanChange(id: string): void {
    this.assertCanStart(id);
    if (this.ports(id))
      throw new AppError(
        409,
        "browser_configuration_managed",
        "Disable Browser Players before changing networking, protected files, add-ons, or Minecraft versions.",
      );
  }
  private log(id: string, message: string): void {
    const operation = this.operation(id);
    const record = this.record(id);
    let safe = message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(0, 2000);
    for (const token of [
      record?.bridgeToken,
      record?.forwardingToken,
      record?.gatewayToken,
    ])
      if (token) safe = safe.split(token).join("[redacted]");
    operation.logs = [
      ...operation.logs,
      { timestamp: new Date().toISOString(), message: safe },
    ].slice(-120);
  }
  private operation(id: string): Operation {
    let state = this.operations.get(id);
    if (!state) {
      state = { phase: "", progressPercent: null, error: null, logs: [] };
      this.operations.set(id, state);
    }
    return state;
  }
  private requireStopped(id: string): ServerRecord {
    const server = this.servers.require(id);
    this.options.assertMaintenance(id);
    if (
      this.stopping ||
      this.options.isProcessActive(id) ||
      ["running", "starting", "stopping", "installing"].includes(server.status)
    )
      throw new AppError(
        409,
        "server_active",
        "Stop the server before changing Browser Players configuration.",
      );
    if (server.installState !== "ready")
      throw new AppError(
        409,
        "server_not_ready",
        "Finish the server installation first.",
      );
    return server;
  }
  async status(id: string) {
    const server = this.servers.require(id);
    const record = this.record(id);
    const operation = this.operation(id);
    const live = this.running.get(id);
    const reasons: string[] = [];
    if (!["paper", "purpur"].includes(server.software))
      reasons.push("Browser Players currently requires Paper or Purpur.");
    const version = server.version.match(/^1\.(19|20|21)(?:\.(\d{1,2}))?$/);
    const maximumPatch: Record<string, number> = { "19": 4, "20": 6, "21": 11 };
    if (!version || Number(version[2] ?? 0) > maximumPatch[version[1]])
      reasons.push(
        "The pinned Velocity gateway targets Minecraft 1.19 through 1.21.11. This Minecraft version needs a separately verified gateway.",
      );
    if (
      !["win32", "linux"].includes(process.platform) ||
      !["x64", "arm64"].includes(process.arch) ||
      (process.platform === "win32" && process.arch !== "x64")
    )
      reasons.push(
        "Browser gateway downloads require Windows x64 or Linux x64/ARM64.",
      );
    return {
      serverId: id,
      configured: record?.configured ?? false,
      enabled: record?.enabled ?? false,
      status: this.hasRecoveryBlock(id)
        ? "recovery_required"
        : operation.error
          ? "error"
          : this.isBusy(id)
            ? "preparing"
            : live?.publicAddress
              ? "running"
              : this.launches.has(id)
                ? "starting"
                : record?.configured
                  ? "ready"
                  : "disabled",
      phase: operation.phase || null,
      progressPercent: operation.progressPercent,
      publicAddress: live?.publicAddress ?? null,
      localAddress: record?.configured
        ? `ws://127.0.0.1:${record.gatewayPort}/`
        : null,
      capabilities: {
        available: reasons.length === 0,
        reasons,
        targetClients: ["Eaglercraft 1.8", "Eaglercraft 1.12.2"],
        verified: false,
      },
      versions: record?.installed?.versions ?? {},
      logs: operation.logs,
      error: record?.recoveryError ?? operation.error,
      ...(record?.preview ? { preview: record.preview } : {}),
    };
  }

  async inspect(id: string) {
    const server = this.requireStopped(id);
    this.assertCanStart(id);
    if (this.ports(id))
      throw new AppError(
        409,
        "browser_already_configured",
        "Browser Players is already configured.",
      );
    const status = await this.status(id);
    if (!status.capabilities.available)
      throw new AppError(
        422,
        "browser_unsupported",
        status.capabilities.reasons.join(" "),
      );
    this.requireStopped(id);
    this.assertCanStart(id);
    this.busy.add(id);
    const previous = this.record(id);
    if (previous) {
      previous.preview = null;
      this.save(id, previous);
    }
    const operation = this.operation(id);
    operation.error = null;
    operation.phase =
      "Checking Java and downloading verified gateway components";
    operation.progressPercent = null;
    const task = this.prepare(server)
      .catch((error: unknown) => {
        operation.error = errorMessage(error);
        this.log(id, operation.error);
        operation.phase = "Setup failed";
      })
      .finally(() => {
        this.busy.delete(id);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    return this.status(id);
  }
  private async prepare(server: ServerRecord): Promise<void> {
    const usable = await this.java.findUsable(21);
    if (!usable)
      throw new AppError(
        422,
        "browser_java_missing",
        "Install Java 21 or newer in Host Settings before preparing Browser Players.",
      );
    const root = await resolveManagedServerRoot(
      this.options.serversDirectory,
      server.directory,
    );
    const info = await statfs(root);
    if (Number(info.bavail) * Number(info.bsize) < 512 * 1024 * 1024)
      throw new AppError(
        507,
        "insufficient_disk_space",
        "Browser setup needs at least 512 MB of free disk space.",
      );
    const installed = await this.dependencies.install(server.id, (message) => {
      this.operation(server.id).phase = message;
      this.log(server.id, message);
    });
    this.log(
      server.id,
      "Downloaded and checksum-verified the browser gateway components.",
    );
    const reserved = new Set(this.servers.list().map((entry) => entry.port));
    const allocate = async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const port = await availablePort();
        if (!reserved.has(port)) {
          reserved.add(port);
          return port;
        }
      }
      throw new AppError(
        409,
        "browser_port_unavailable",
        "Could not allocate isolated gateway ports.",
      );
    };
    const record: BrowserRecord = {
      configured: false,
      enabled: false,
      backendPort: await allocate(),
      wakePort: await allocate(),
      gatewayPort: await allocate(),
      authPort: await allocate(),
      javaPath: usable.installation.path,
      installed,
      bridgeToken: randomBytes(32).toString("hex"),
      forwardingToken: randomBytes(32).toString("hex"),
      gatewayToken: randomBytes(32).toString("hex"),
      owned: [],
      files: [],
      preview: null,
      journal: null,
      recoveryError: null,
    };
    await this.makeChanges(server, root, record);
    record.preview = {
      revision: this.revision(server, record.files),
      changes: [
        `Move Minecraft to the private loopback port ${record.backendPort}. Keep Java joins on port ${server.port} through Velocity.`,
        "Verify Java accounts at the proxy and require local passwords for browser accounts.",
        "Enable BungeeGuard forwarding and install its verified backend plugin.",
        "Expose the game gateway using a temporary Cloudflare WSS tunnel when enabled.",
      ],
      warnings: [
        "Experimental. A playable browser connection has not been verified for this combination.",
        "Enabling changes authentication and networking configuration. Browser identities have separate UUIDs and player progress.",
        "Temporary Cloudflare addresses change after tunnel restarts and have no uptime guarantee.",
      ],
    };
    this.save(server.id, record);
    this.operation(server.id).phase = "Ready for configuration approval";
    this.operation(server.id).progressPercent = 100;
  }
  private revision(server: ServerRecord, files: BrowserFileChange[]): string {
    return digest(
      JSON.stringify({
        version: server.version,
        software: server.software,
        game: server.game,
        startup: server.startupConfig,
        port: server.port,
        files,
      }),
    );
  }
  private async makeChanges(
    server: ServerRecord,
    root: string,
    record: BrowserRecord,
  ): Promise<void> {
    const properties = await readConfiguration(root, "server.properties");
    if (properties === null)
      throw new AppError(
        409,
        "browser_properties_missing",
        "Start and stop the server once to create its configuration before setting up browser access.",
      );
    const original = parseJavaProperties(properties);
    let output = properties;
    for (const [key, value] of Object.entries({
      "server-port": String(record.backendPort),
      "server-ip": "127.0.0.1",
      "online-mode": "false",
      "enforce-secure-profile": "false",
    })) {
      record.owned.push({
        path: "server.properties",
        keys: [key],
        before: original[key],
        after: value,
      });
      output = patchJavaProperties(output, { [key]: value });
    }
    record.files.push({
      path: "server.properties",
      before: properties,
      after: output,
    });
    const yamlSettings = [
      { path: "spigot.yml", keys: ["settings", "bungeecord"], value: true },
      {
        path: "config/paper-global.yml",
        keys: ["proxies", "velocity", "enabled"],
        value: false,
      },
      {
        path: "config/paper-global.yml",
        keys: ["proxies", "bungee-cord", "online-mode"],
        value: true,
      },
    ];
    for (const setting of yamlSettings) {
      let file = record.files.find((entry) => entry.path === setting.path);
      if (!file) {
        const before = await readConfiguration(root, setting.path);
        file = { path: setting.path, before, after: before ?? "" };
        record.files.push(file);
      }
      const patched = patchYaml(file.after, setting.keys, setting.value);
      record.owned.push({
        path: setting.path,
        keys: setting.keys,
        before: patched.previous,
        after: setting.value,
      });
      file.after = patched.text;
    }
    const guardConfig = "plugins/BungeeGuard/config.yml";
    const guardBefore = await readConfiguration(root, guardConfig);
    if (guardBefore !== null)
      throw new AppError(
        409,
        "browser_existing_proxy",
        "An existing BungeeGuard configuration needs manual review before NodePilot can manage this gateway.",
      );
    record.files.push({
      path: guardConfig,
      before: null,
      after: `allowed-tokens:\n  - ${record.forwardingToken}\n`,
    });
  }

  async setup(id: string, revision: string) {
    const server = this.requireStopped(id);
    this.assertCanStart(id);
    const record = this.record(id);
    if (
      !record?.installed ||
      !record.preview ||
      record.preview.revision !== revision ||
      record.configured
    )
      throw new AppError(
        409,
        "browser_preview_stale",
        "Prepare a fresh Browser Players preview before applying changes.",
      );
    this.busy.add(id);
    try {
      const root = await resolveManagedServerRoot(
        this.options.serversDirectory,
        server.directory,
      );
      for (const change of record.files)
        if ((await readConfiguration(root, change.path)) !== change.before)
          throw new AppError(
            409,
            "browser_preview_stale",
            "Configuration changed since inspection. Prepare a fresh preview.",
          );
      if (this.revision(server, record.files) !== revision)
        throw new AppError(
          409,
          "browser_preview_stale",
          "The server version or port changed. Prepare a fresh preview.",
        );
      for (const port of [
        server.port,
        record.backendPort,
        record.wakePort,
        record.gatewayPort,
        record.authPort,
      ]) {
        if (this.servers.portIsAssigned(port, id))
          throw new AppError(
            409,
            "browser_port_assigned",
            "A gateway port was assigned to another server after inspection. Prepare a fresh preview.",
          );
        this.assertPortNotReserved(port);
        await availablePort(port);
      }
      const backupRoot = path.join(
        record.installed.directory,
        "configuration-backups",
        randomUUID(),
      );
      await mkdir(backupRoot, { recursive: true });
      for (const change of record.files)
        if (change.before !== null)
          await writeConfiguration(backupRoot, change.path, change.before);
      // A pre-existing guard JAR may use a conflicting filename or configuration.
      const { readdir } = await import("node:fs/promises");
      const plugins = await browserConfigurationPath(root, "plugins");
      await mkdir(plugins, { recursive: true });
      if (
        (await readdir(plugins)).some((name) =>
          /bungeeguard.*\.jar$/i.test(name),
        )
      )
        throw new AppError(
          409,
          "browser_existing_guard",
          "Remove or review the existing BungeeGuard plugin before setting up this managed gateway.",
        );
      record.journal = { kind: "setup", changes: record.files };
      this.save(id, record);
      await this.writeProxyConfiguration(server, record);
      await copyFile(
        record.installed.bungeeGuardJar,
        await browserConfigurationPath(
          root,
          "plugins/NodePilot-BungeeGuard.jar",
        ),
        1,
      );
      for (const change of record.files)
        await writeConfiguration(root, change.path, change.after);
      record.configured = true;
      record.journal = null;
      record.preview = null;
      this.save(id, record);
      this.log(
        id,
        `Saved configuration backup ${path.basename(backupRoot)}. Browser gateway prepared; enable it before starting Minecraft.`,
      );
    } catch (error) {
      await this.rollback(id);
      throw error;
    } finally {
      this.busy.delete(id);
    }
    return this.status(id);
  }

  private async writeProxyConfiguration(
    server: ServerRecord,
    record: BrowserRecord,
  ): Promise<void> {
    if (!record.installed) throw new Error("Browser dependencies are missing.");
    const root = record.installed.directory;
    const protocol = minecraftReleaseProtocol(server.version);
    if (protocol === null) throw new AppError(422, "browser_protocol_unknown", "This Minecraft version has no verified browser gateway protocol mapping.");
    const velocity = `config-version = "2.7"\nbind = "0.0.0.0:${server.port}"\nmotd = "NodePilot Browser Gateway"\nshow-max-players = 100\nonline-mode = true\nforce-key-authentication = false\nplayer-info-forwarding-mode = "bungeeguard"\nforwarding-secret-file = "forwarding.secret"\n[servers]\nnodepilot = "127.0.0.1:${record.wakePort}"\ntry = ["nodepilot"]\n[forced-hosts]\n[advanced]\nlogin-ratelimit = 1000\nread-timeout = 30000\n`;
    await writeConfiguration(root, "velocity.toml", velocity);
    // Sleeping wake listeners echo the probing client's protocol. Auto-detection
    // would cache that value and reject browser joins until a later live ping.
    await writeConfiguration(root, "plugins/viaversion/config.yml",
      `velocity-ping-interval: -1\nvelocity-ping-save: false\nvelocity-servers:\n  default: ${protocol}\n  nodepilot: ${protocol}\n`);
    await writeConfiguration(root, "forwarding.secret", record.forwardingToken);
    await writeConfiguration(
      root,
      "eagler_forwarding.secret",
      record.gatewayToken,
    );
    await writeConfiguration(
      root,
      "plugins/eaglerxserver/settings.toml",
      "enable_authentication_events = true\n",
    );
    await writeConfiguration(
      root,
      "plugins/eaglerxserver/listeners.toml",
      `[[listener_list]]\nlistener_name = "nodepilot"\ninject_address = "0.0.0.0:${server.port}"\nvelocity_clone_listener = false\ndual_stack = true\nforward_secret = true\nforward_secret_header = "X-Eagler-Secret"\nforward_secret_file = "eagler_forwarding.secret"\n`,
    );
    await writeConfiguration(
      root,
      "plugins/nodepilot-browser-auth/config.json",
      JSON.stringify({
        serverId: server.id,
        verifyUrl: `http://127.0.0.1:${record.authPort}/verify`,
        token: record.bridgeToken,
      }),
    );
  }

  async validateStart(id: string): Promise<void> {
    this.assertCanStart(id);
    const record = this.record(id);
    if (!record?.configured) return;
    if (!record.enabled)
      throw new AppError(
        409,
        "browser_gateway_disabled",
        "Enable Browser Players before starting the server, or disable its configuration to restore direct Java connections.",
      );
    const server = this.servers.require(id);
    const root = await resolveManagedServerRoot(
      this.options.serversDirectory,
      server.directory,
    );
    for (const setting of record.owned) {
      const text = (await readConfiguration(root, setting.path)) ?? "";
      // The restore validator also checks ownership without writing anything.
      restoreSettings(text, [setting], setting.path.endsWith(".properties"));
    }
    const guard = record.files.find(
      (entry) => entry.path === "plugins/BungeeGuard/config.yml",
    );
    if (!guard || (await readConfiguration(root, guard.path)) !== guard.after)
      throw new AppError(
        409,
        "browser_guard_configuration_changed",
        "Restore the managed BungeeGuard configuration before starting Minecraft.",
      );
    await this.checkGuard(root, record);
    await this.ensureOnline(id);
  }

  async enable(id: string) {
    this.requireStopped(id);
    this.assertCanStart(id);
    const record = this.record(id);
    if (!record?.configured)
      throw new AppError(
        409,
        "browser_not_configured",
        "Set up Browser Players first.",
      );
    record.enabled = true;
    this.save(id, record);
    this.operation(id).error = null;
    const task = this.ensureOnline(id).catch((error: unknown) => {
      this.operation(id).error = errorMessage(error);
      this.log(id, errorMessage(error));
    });
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return this.status(id);
  }

  private async ensureOnline(id: string): Promise<void> {
    if (this.stopping)
      throw new AppError(
        409,
        "browser_stopping",
        "NodePilot is shutting down.",
      );
    const launch = this.launches.get(id);
    if (launch) return launch;
    if (this.running.get(id)?.publicAddress) return;
    const task = this.launch(id).finally(() => this.launches.delete(id));
    this.launches.set(id, task);
    return task;
  }

  private async launch(id: string): Promise<void> {
    const record = this.record(id);
    const server = this.servers.require(id);
    if (!record?.configured || !record.enabled || !record.installed)
      throw new AppError(
        409,
        "browser_not_enabled",
        "Enable Browser Players before starting its gateway.",
      );
    const live: Running = {
      children: [],
      http: [],
      aliases: new Map(),
      sockets: new Set(),
      publicAddress: null,
      stopping: false,
    };
    this.running.set(id, live);
    try {
      this.operation(id).phase = "Starting the authenticated browser gateway";
      await this.authListener(id, record, live);
      const velocity = await this.launchProcess(
        id,
        live,
        record.javaPath,
        ["-Xms64M", "-Xmx256M", "-jar", record.installed.velocityJar],
        record.installed.directory,
        /NODEPILOT_BROWSER_AUTH_READY[\s\S]*Done \(/,
      );
      if (!velocity || live.stopping || this.stopping)
        throw new Error("The authenticated gateway startup was cancelled.");
      await this.refreshRouting(id);
      await this.gatewayListener(server, record, live);
      const tunnelOutput = await this.launchProcess(
        id,
        live,
        record.installed.cloudflared,
        [
          "tunnel",
          "--no-autoupdate",
          "--url",
          `http://127.0.0.1:${record.gatewayPort}`,
        ],
        record.installed.directory,
        /(?=[\s\S]*https:\/\/[a-z0-9-]+\.trycloudflare\.com)(?=[\s\S]*Registered tunnel connection)/i,
      );
      const match = tunnelOutput.match(
        /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i,
      );
      if (!match || live.stopping)
        throw new Error(
          "Cloudflare did not provide a temporary public address.",
        );
      const address = `wss://${match[1]}/`;
      await this.probePublicGateway(address, live);
      if (live.stopping || this.stopping)
        throw new Error("Gateway startup was cancelled.");
      live.publicAddress = address;
      this.operation(id).phase = "Browser gateway running";
      this.log(
        id,
        "Temporary public WSS address is ready. Playable client compatibility remains unverified.",
      );
    } catch (error) {
      await this.stopOwned(id);
      throw error;
    }
  }

  private async probePublicGateway(
    address: string,
    live: Running,
  ): Promise<void> {
    let lastError = "The public WebSocket endpoint did not respond.";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (live.stopping || this.stopping)
        throw new Error("Gateway startup was cancelled.");
      try {
        const controller = new AbortController();
        live.probe = controller;
        await new Promise<void>((resolve, reject) => {
          const key = randomBytes(16).toString("base64");
          const expected = createHash("sha1")
            .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            .digest("base64");
          const request = httpsRequest(
            address.replace(/^wss:/, "https:"),
            {
              headers: {
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": key,
              },
              timeout: 5000,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now())))]),
            },
            (response) => {
              response.resume();
              reject(
                new Error(
                  `The public gateway returned HTTP ${response.statusCode}.`,
                ),
              );
            },
          );
          request.once("upgrade", (response, socket) => {
            socket.destroy();
            if (
              response.statusCode === 101 &&
              response.headers["sec-websocket-accept"] === expected
            )
              resolve();
            else
              reject(
                new Error(
                  "The public gateway returned an invalid WebSocket handshake.",
                ),
              );
          });
          request.once("timeout", () =>
            request.destroy(new Error("The public gateway check timed out.")),
          );
          request.once("error", reject);
          request.end();
        });
        return;
      } catch (error) {
        lastError = errorMessage(error);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(2000, deadline - Date.now()))));
    }
    throw new AppError(
      502,
      "browser_public_gateway_unreachable",
      `${lastError} Check this computer's internet access and retry the gateway.`,
    );
  }

  private launchProcess(
    id: string,
    live: Running,
    executable: string,
    args: string[],
    cwd: string,
    ready: RegExp,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (live.stopping || this.stopping) {
        reject(new Error("Gateway startup was cancelled."));
        return;
      }
      let settled = false;
      let output = "";
      const child = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      live.children.push(child);
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new AppError(
              502,
              "browser_start_timeout",
              "A gateway component did not become ready within 90 seconds. Check Browser Players logs.",
            ),
          );
        }
      }, 90_000);
      const consume = (chunk: Buffer) => {
        const text = chunk.toString();
        output = (output + text).slice(-32_768);
        for (const line of text.split(/\r?\n/).filter(Boolean))
          this.log(id, line);
        if (!settled && ready.test(output)) {
          settled = true;
          clearTimeout(timer);
          resolve(output);
        }
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      child.once("error", (error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(
            new AppError(
              502,
              "browser_process_failed",
              `Could not run a browser gateway component. ${error.message}`,
            ),
          );
        }
      });
      child.once("close", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(
            new AppError(
              502,
              "browser_process_exited",
              "A browser gateway component stopped before becoming ready. Check Browser Players logs.",
            ),
          );
        }
        if (!live.stopping) {
          this.operation(id).error =
            "A browser gateway component stopped. Enable Browser Players again to retry.";
          void this.stopOwned(id);
        }
      });
    });
  }

  private async authListener(
    id: string,
    record: BrowserRecord,
    live: Running,
  ): Promise<void> {
    const listener = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (
        request.method !== "POST" ||
        request.url !== "/verify" ||
        request.socket.remoteAddress !== "127.0.0.1" ||
        !equalToken(
          request.headers.authorization ?? "",
          `Bearer ${record.bridgeToken}`,
        )
      ) {
        response.writeHead(403).end();
        return;
      }
      let input = "";
      let overflow = false;
      request.on("data", (chunk: Buffer) => {
        input += chunk.toString();
        if (Buffer.byteLength(input) > 2048) {
          overflow = true;
          request.destroy();
        }
      });
      request.on("end", () => {
        void (async () => {
          if (overflow || live.stopping) {
            response.writeHead(403).end();
            return;
          }
          const body = JSON.parse(input) as {
            name?: unknown;
            password?: unknown;
          };
          if (
            typeof body.name !== "string" ||
            typeof body.password !== "string"
          ) {
            response.writeHead(400).end();
            return;
          }
          const identity = await this.accounts.verify(
            id,
            body.name,
            body.password,
          );
          const reserved = identity ? await this.reservedIdentities(id) : [];
          if (
            identity &&
            reserved.some(
              (entry) =>
                (entry.uuid?.toLowerCase() === identity.uuid.toLowerCase() &&
                  entry.name.toLowerCase() !== identity.name.toLowerCase()) ||
                (entry.name.toLowerCase() === identity.name.toLowerCase() &&
                  entry.uuid?.toLowerCase() !== identity.uuid.toLowerCase()),
            )
          ) {
            response.writeHead(403).end();
            return;
          }
          if (identity && !live.stopping) {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ ok: true, ...identity }));
          } else response.writeHead(403).end();
        })().catch(() => {
          if (!response.headersSent) response.writeHead(403);
          response.end();
        });
      });
    });
    await this.listen(listener, record.authPort, live);
  }

  private async gatewayListener(
    server: ServerRecord,
    record: BrowserRecord,
    live: Running,
  ): Promise<void> {
    const listener = createServer((_request, response) =>
      response.writeHead(404).end(),
    );
    listener.on("upgrade", (request, client, head) => {
      if (
        live.stopping ||
        !["/", "/play"].includes(request.url ?? "") ||
        request.headers.upgrade?.toLowerCase() !== "websocket" ||
        typeof request.headers["sec-websocket-key"] !== "string" ||
        live.sockets.size >= 128
      ) {
        client.destroy();
        return;
      }
      const upstream = net.connect({ host: "127.0.0.1", port: server.port });
      const downstream = client as net.Socket;
      live.sockets.add(upstream);
      live.sockets.add(downstream);
      const cleanup = () => {
        upstream.destroy();
        downstream.destroy();
        live.sockets.delete(upstream);
        live.sockets.delete(downstream);
      };
      upstream.on("error", cleanup);
      downstream.on("error", cleanup);
      upstream.on("close", cleanup);
      downstream.on("close", cleanup);
      upstream.setTimeout(30_000, () => {
        if (upstream.bytesRead === 0) cleanup();
      });
      upstream.once("connect", () => {
        const headers = [
          `GET / HTTP/1.1`,
          `Host: 127.0.0.1:${server.port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          `X-Eagler-Secret: ${record.gatewayToken}`,
        ];
        for (const key of [
          "sec-websocket-key",
          "sec-websocket-version",
          "sec-websocket-protocol",
          "origin",
        ]) {
          const value = request.headers[key];
          if (typeof value === "string") headers.push(`${key}: ${value}`);
        }
        upstream.write(headers.join("\r\n") + "\r\n\r\n");
        if (head.length) upstream.write(head);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      });
    });
    await this.listen(listener, record.gatewayPort, live);
  }
  private async listen(
    listener: HttpServer,
    port: number,
    live: Running,
  ): Promise<void> {
    if (live.stopping || this.stopping)
      throw new Error("Gateway startup was cancelled.");
    listener.requestTimeout = 10_000;
    listener.headersTimeout = 10_000;
    live.http.push(listener);
    await this.bindListener(listener, port, "127.0.0.1", live);
  }

  private bindListener(
    listener: net.Server,
    port: number,
    host: string,
    live: Running,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        listener.removeListener("close", closed);
        listener.removeListener("error", failed);
      };
      const closed = () => {
        cleanup();
        reject(new Error("Gateway listener startup was cancelled."));
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      listener.once("close", closed);
      listener.once("error", failed);
      // Keep a handler after binding too. Unexpected listener failures must not crash NodePilot.
      listener.on("error", () => {
        listener.close();
      });
      listener.listen(port, host, () => {
        cleanup();
        if (live.stopping || this.stopping) {
          listener.close();
          reject(new Error("Gateway listener startup was cancelled."));
        } else resolve();
      });
    });
  }

  async refreshRouting(id: string): Promise<void> {
    const live = this.running.get(id);
    if (!live || live.stopping || this.stopping) return;
    const server = this.servers.require(id);
    const desired = this.options.wakePort?.(server) ?? null;
    for (const [port, listener] of live.aliases)
      if (port !== desired) {
        listener.close();
        live.aliases.delete(port);
      }
    if (
      desired === null ||
      desired === server.port ||
      live.aliases.has(desired)
    )
      return;
    this.assertPortNotReserved(desired);
    const listener = net.createServer((client) => {
      if (live.stopping || live.sockets.size >= 128) {
        client.destroy();
        return;
      }
      const target = net.connect({ host: "127.0.0.1", port: server.port });
      live.sockets.add(client);
      live.sockets.add(target);
      const close = () => {
        client.destroy();
        target.destroy();
        live.sockets.delete(client);
        live.sockets.delete(target);
      };
      client.on("error", close);
      target.on("error", close);
      client.on("close", close);
      target.on("close", close);
      client.pipe(target);
      target.pipe(client);
    });
    live.aliases.set(desired, listener);
    try {
      await this.bindListener(listener, desired, "0.0.0.0", live);
    } catch (error) {
      live.aliases.delete(desired);
      listener.close();
      throw error;
    }
  }

  async disable(id: string) {
    const server = this.requireStopped(id);
    this.assertCanStart(id);
    const record = this.record(id);
    if (!record?.configured) return this.status(id);
    this.busy.add(id);
    try {
      await this.stopOwned(id);
      await this.launches.get(id)?.catch(() => undefined);
      const root = await resolveManagedServerRoot(
        this.options.serversDirectory,
        server.directory,
      );
      const changes: BrowserFileChange[] = [];
      for (const file of record.files) {
        const current = await readConfiguration(root, file.path);
        const settings = record.owned.filter(
          (setting) => setting.path === file.path,
        );
        let restored = settings.length
          ? restoreSettings(
              current ?? "",
              settings,
              file.path.endsWith(".properties"),
            )
          : current === file.after
            ? file.before
            : undefined;
        if (
          file.before === null &&
          typeof restored === "string" &&
          ["", "{}", "null"].includes(restored.trim())
        )
          restored = null;
        if (restored === undefined)
          throw new AppError(
            409,
            "browser_configuration_conflict",
            "Browser gateway configuration was edited externally. Review the changed file before disabling.",
          );
        changes.push({ path: file.path, before: current, after: restored });
      }
      record.journal = { kind: "disable", changes };
      this.save(id, record);
      for (const file of changes)
        await writeConfiguration(root, file.path, file.after);
      await this.removeGuard(root, record);
      record.configured = false;
      record.enabled = false;
      record.journal = null;
      this.save(id, record);
      this.operation(id).error = null;
      this.operation(id).phase = "Direct Java connections restored";
    } catch (error) {
      await this.rollback(id);
      throw error;
    } finally {
      this.busy.delete(id);
    }
    return this.status(id);
  }
  private async removeGuard(
    root: string,
    record: BrowserRecord,
  ): Promise<void> {
    const target = await browserConfigurationPath(
      root,
      "plugins/NodePilot-BungeeGuard.jar",
    );
    try {
      const expected = await readFile(record.installed!.bungeeGuardJar);
      if (
        !equalToken(
          digest((await readFile(target)).toString("base64")),
          digest(expected.toString("base64")),
        )
      )
        throw new AppError(
          409,
          "browser_guard_conflict",
          "The managed BungeeGuard JAR was changed. Review it before disabling.",
        );
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async checkGuard(root: string, record: BrowserRecord): Promise<void> {
    const target = await browserConfigurationPath(
      root,
      "plugins/NodePilot-BungeeGuard.jar",
    );
    const info = await lstat(target);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 20_000_000 ||
      digest((await readFile(target)).toString("base64")) !==
        digest(
          (await readFile(record.installed!.bungeeGuardJar)).toString("base64"),
        )
    )
      throw new AppError(
        409,
        "browser_guard_changed",
        "Restore the verified BungeeGuard plugin before starting Minecraft.",
      );
  }
  private async rollback(id: string): Promise<void> {
    const record = this.record(id);
    if (!record?.journal) return;
    const server = this.servers.require(id);
    const root = await resolveManagedServerRoot(
      this.options.serversDirectory,
      server.directory,
    );
    try {
      for (const file of record.journal.changes) {
        const current = await readConfiguration(root, file.path);
        if (current !== file.before && current !== file.after)
          throw new Error(
            `Recovery found an external edit in ${file.path}. Restore the configuration backup before retrying.`,
          );
      }
      for (const file of record.journal.changes)
        await writeConfiguration(root, file.path, file.before);
      if (record.journal.kind === "setup") await this.removeGuard(root, record);
      if (record.journal.kind === "disable") {
        const target = await browserConfigurationPath(
          root,
          "plugins/NodePilot-BungeeGuard.jar",
        );
        try {
          await lstat(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await copyFile(record.installed!.bungeeGuardJar, target, 1);
        }
        await this.checkGuard(root, record);
      }
      record.journal = null;
      record.recoveryError = null;
      this.save(id, record);
    } catch (error) {
      record.recoveryError = errorMessage(error);
      this.save(id, record);
    }
  }
  async recover(): Promise<void> {
    for (const server of this.servers.list())
      if (this.record(server.id)?.journal) await this.rollback(server.id);
  }
  async resume(): Promise<void> {
    for (const server of this.servers.list())
      if (this.isEnabled(server.id) && !this.hasRecoveryBlock(server.id)) {
        const task = this.ensureOnline(server.id).catch((error: unknown) => {
          this.operation(server.id).error = errorMessage(error);
        });
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
      }
  }
  async stopOwned(id: string): Promise<void> {
    const live = this.running.get(id);
    if (!live) return;
    live.stopping = true;
    live.probe?.abort();
    live.publicAddress = null;
    for (const socket of live.sockets) socket.destroy();
    for (const listener of live.aliases.values()) listener.close();
    for (const listener of live.http) {
      listener.closeAllConnections();
      listener.close();
    }
    await Promise.all(
      live.children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 5000);
            timer.unref();
            child.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            child.kill();
          }),
      ),
    );
    if (this.running.get(id) === live) this.running.delete(id);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.dependencies.cancelAll?.();
    await Promise.all([...this.running.keys()].map((id) => this.stopOwned(id)));
    await Promise.allSettled([...this.tasks]);
  }
  async reservedIdentities(
    id: string,
  ): Promise<Array<{ name: string; uuid?: string }>> {
    const server = this.servers.require(id);
    const root = await resolveManagedServerRoot(
      this.options.serversDirectory,
      server.directory,
    );
    const result: Array<{ name: string; uuid?: string }> = [];
    for (const relative of ["ops.json", "whitelist.json", "usercache.json"]) {
      const text = await readConfiguration(root, relative);
      if (!text) continue;
      let entries: unknown;
      try {
        entries = JSON.parse(text);
      } catch {
        throw new AppError(
          409,
          "browser_identity_file_invalid",
          `Repair ${relative} before creating browser identities.`,
        );
      }
      if (!Array.isArray(entries))
        throw new AppError(
          409,
          "browser_identity_file_invalid",
          `Repair ${relative} before creating browser identities.`,
        );
      for (const entry of entries)
        if (entry && typeof entry.name === "string")
          result.push({
            name: entry.name,
            uuid: typeof entry.uuid === "string" ? entry.uuid : undefined,
          });
    }
    return result;
  }

  async createAccount(id: string, input: { name: string; password: string }) {
    this.requireStopped(id);
    this.assertCanStart(id);
    this.busy.add(id);
    try {
      return await this.accounts.create(
        id,
        input,
        await this.reservedIdentities(id),
      );
    } finally {
      this.busy.delete(id);
    }
  }
}
