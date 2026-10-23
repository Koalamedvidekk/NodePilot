import { createWriteStream } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getConfig, loadEnv, updateEnvFile } from './config.js';
loadEnv();

import { openDatabase } from './db.js';
import { AppError, asAppError, errorMessage } from './lib/errors.js';
import { InstanceLock } from './lib/lockfile.js';
import { formatAccessUrls, getLocalNetworkAddresses, isAllowedOrigin } from './lib/network.js';
import { ensureDirectory, managedServerDirectoryExists, resolveManagedServerRoot, safeDirectoryName } from './lib/paths.js';
import { runInteractiveSetup, shouldRunFirstTimeSetup } from './setup.js';
import { ServerRepository } from './repositories/server-repository.js';
import { HostSettingsRepository } from './repositories/host-settings-repository.js';
import { ServerTunnelRepository } from './repositories/server-tunnel-repository.js';
import { ServerSettingsRepository } from './repositories/server-settings-repository.js';
import { FileService } from './services/file-service.js';
import { JavaService } from './services/java-service.js';
import { ImportService } from './services/import-service.js';
import { AddonService } from './services/addon-service.js';
import { MinecraftService } from './services/minecraft-service.js';
import { PlayerBridgeManager } from './services/player-bridge.js';
import { PlayerService, type PlayerAction } from './services/player-service.js';
import { ProcessMetricsService } from './services/process-metrics-service.js';
import { ServerRuntime } from './services/server-runtime.js';
import { SystemService } from './services/system-service.js';
import { StartupService } from './services/startup-service.js';
import { PlayitService } from './services/playit-service.js';
import { AutoStartService } from './services/auto-start-service.js';
import { ServerTunnelService } from './services/server-tunnel-service.js';
import { AutoSleepService } from './services/auto-sleep-service.js';
import { WakeProxyService } from './services/wake-proxy-service.js';
import { UpdateService } from './services/update-service.js';
import { parseMemoryMb, validateCustomJvmArgs } from './lib/settings-helpers.js';
import type { AutoStartMode, HostDiagnostics, HostSettings, HostStartupStatus, JavaInstallation, PlayitStatus, ProvisionableServerSoftware, ServerRecord, ServerStatus, ServerTunnel } from './types.js';

let config = getConfig();
let currentListeningHost = config.host;
const idSchema = z.string().uuid();
const flavorSchema = z.enum(['vanilla', 'paper']);
const softwareSchema = z.enum(['vanilla', 'paper', 'spigot', 'purpur', 'fabric', 'forge', 'neoforge', 'quilt', 'bedrock']);
const serverParamsSchema = z.object({ id: idSchema });
const createServerSchema = z.object({
  name: z.string().trim().min(1).max(64).refine((value) => !/[\x00-\x1f\x7f\r\n]/.test(value), 'Name cannot contain control characters.'),
  flavor: flavorSchema.optional(),
  software: softwareSchema.optional(),
  version: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Version has unsupported characters.'),
  port: z.number().int().min(1).max(65_535).optional(),
  memoryMb: z.number().int().min(256).max(65_536).default(2_048),
  eulaAccepted: z.literal(true, { errorMap: () => ({ message: 'You must explicitly accept the Minecraft EULA.' }) }),
  javaPath: z.string().min(1).max(1_024).optional(),
  enablePlayit: z.boolean().optional().default(false),
}).refine((value) => Boolean(value.software ?? value.flavor), 'Choose a server software implementation.');
const updateServerSchema = z.object({
  name: z.string().trim().min(1).max(64).refine((value) => !/[\x00-\x1f\x7f\r\n]/.test(value), 'Name cannot contain control characters.').optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  memoryMb: z.number().int().min(256).max(65_536).optional(),
  javaPath: z.string().min(1).max(1_024).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'Supply at least one value to update.');
const propertiesSchema = z.object({ values: z.record(z.string().max(512)) });
const fileContentSchema = z.object({
  path: z.string().min(1).max(512),
  content: z.string().max(1_000_000),
});
const fileRenameSchema = z.object({
  path: z.string().min(1).max(512),
  newName: z.string().trim().min(1).max(255),
});
const fileCopySchema = z.object({
  sourcePath: z.string().min(1).max(512),
  destinationDir: z.string().max(512).default(''),
});
const fileMoveSchema = z.object({
  sourcePath: z.string().min(1).max(512),
  destinationDir: z.string().max(512).default(''),
});
const fileCreateFileSchema = z.object({
  parentPath: z.string().max(512).default(''),
  name: z.string().trim().min(1).max(255),
  content: z.string().max(1_000_000).default(''),
});
const fileCreateFolderSchema = z.object({
  parentPath: z.string().max(512).default(''),
  name: z.string().trim().min(1).max(255),
});
const fileDeleteSchema = z.object({
  path: z.string().min(1).max(512),
});
const installJavaSchema = z.object({ major: z.number().int().min(8).max(35) });
const pinVerifySchema = z.object({ pin: z.string().min(1).max(64) });
const networkUpdateSchema = z.object({
  host: z.enum(['127.0.0.1', '0.0.0.0']),
  pin: z.string().max(64).nullable().optional(),
});
const hostSettingsUpdateSchema = z.object({
  systemStartupEnabled: z.boolean().optional(),
  launchMode: z.enum(['headless', 'windowed']).optional(),
  openBrowserOnStartup: z.boolean().optional(),
  continueRunningOnClose: z.boolean().optional(),
});
const hostStartupEnableSchema = z.object({
  launchMode: z.enum(['headless', 'windowed']).optional(),
  openBrowserOnStartup: z.boolean().optional(),
});
const updatePreferencesSchema = z.object({
  includePrereleases: z.boolean(),
});
const serverAutoStartSchema = z.object({
  autoStart: z.enum(['always', 'disabled']),
});
const serverSettingsSectionSchema = z.enum(['auto-wake', 'auto-sleep', 'java', 'startup']);
const resetServerSettingsSchema = z.object({
  section: serverSettingsSectionSchema,
});
const updateServerSettingsSchema = z.object({
  autoWake: z.boolean().optional(),
  wakeProxyPort: z.number().int().min(1).max(65_535).nullable().optional(),
  autoSleep: z.boolean().optional(),
  idleTimeoutMinutes: z.number().int().min(1).max(1_440).optional(),
  minMemory: z.union([z.string().min(1).max(32), z.number().int()]).nullable().optional(),
  maxMemory: z.union([z.string().min(1).max(32), z.number().int()]).optional(),
  minMemoryMb: z.number().int().min(256).max(65_536).nullable().optional(),
  maxMemoryMb: z.number().int().min(256).max(65_536).optional(),
  customJvmArgs: z.array(z.string().max(256)).optional(),
  autoStart: z.enum(['always', 'disabled']).optional(),
  shutdownTimeoutSeconds: z.number().int().min(5).max(300).optional(),
  name: z.string().trim().min(1).max(64).refine((value) => !/[\x00-\x1f\x7f\r\n]/.test(value), 'Name cannot contain control characters.').optional(),
  port: z.number().int().min(1).max(65_535).optional(),
});
const playitSecretSchema = z.object({
  secretKey: z.string().trim().min(1).max(256),
});
const commandSchema = z.object({ command: z.string().min(1).max(500) });
const versionQuerySchema = z.object({ flavor: flavorSchema.optional(), software: softwareSchema.optional() }).refine(
  (value) => Boolean(value.software ?? value.flavor),
  'Choose a server software implementation.',
);
const requirementsQuerySchema = z.object({
  flavor: flavorSchema.optional(),
  software: softwareSchema.optional(),
  version: z.string().trim().min(1).max(64),
}).refine((value) => Boolean(value.software ?? value.flavor), 'Choose a server software implementation.');
const filePathQuerySchema = z.object({ path: z.string().max(512).default('') });
const logsQuerySchema = z.object({ tail: z.coerce.number().int().min(1).max(1_200).default(300) });
const importDirectorySchema = z.object({ path: z.string().trim().min(1).max(4_096) });
const importServerSchema = z.object({
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('directory'), path: z.string().trim().min(1).max(4_096) }),
    z.object({ type: z.literal('archive'), uploadId: z.string().uuid() }),
  ]),
  name: z.string().trim().min(1).max(64).refine((value) => !/[\x00-\x1f\x7f\r\n]/.test(value), 'Name cannot contain control characters.'),
  flavor: flavorSchema.optional(),
  software: softwareSchema.optional(),
  version: z.string().trim().max(64).regex(/^[A-Za-z0-9._-]*$/, 'Version has unsupported characters.').optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  memoryMb: z.number().int().min(256).max(65_536).default(2_048),
  eulaAccepted: z.literal(true, { errorMap: () => ({ message: 'You must explicitly accept the Minecraft EULA.' }) }),
}).refine((value) => Boolean(value.software ?? value.flavor), 'Choose a server software implementation.');
const addonTypeSchema = z.enum(['plugin', 'mod']);
const addonSearchQuerySchema = z.object({
  type: addonTypeSchema,
  source: z.enum(['modrinth', 'hangar']),
  query: z.string().trim().min(1).max(100),
});
const addonInstallSchema = z.object({
  type: addonTypeSchema,
  projectId: z.string().trim().min(3).max(128),
  allowMissingDependencies: z.boolean().optional().default(false),
});
const hangarInstallSchema = z.object({ projectId: z.string().trim().min(3).max(128) });
const addonUpdateSchema = z.object({
  type: addonTypeSchema,
  fileName: z.string().trim().min(1).max(256),
});
const addonRemoveParamsSchema = z.object({ id: idSchema, type: addonTypeSchema, fileName: z.string().trim().min(1).max(256) });
const addonUploadQuerySchema = z.object({ type: addonTypeSchema });
const addonRemoveSchema = z.object({ confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm add-on removal before continuing.' }) }) });
const MAX_IMPORT_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ADDON_UPLOAD_BYTES = 256 * 1024 * 1024;
const playerReferenceSchema = z.string().trim().min(3).max(64).refine(
  (value) => /^[A-Za-z0-9_]{3,16}$/.test(value) || /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value),
  'Player references must be a Minecraft name or UUID.',
);
const playerParamsSchema = z.object({ id: idSchema, player: playerReferenceSchema });
const playerActionSchema = z.object({
  player: playerReferenceSchema,
  action: z.enum(['op', 'deop', 'kick', 'ban', 'unban', 'heal', 'teleport', 'gamemode', 'inventory']),
  reason: z.string().trim().max(160).optional(),
  gamemode: z.enum(['survival', 'creative', 'adventure', 'spectator']).optional(),
  teleport: z.object({
    x: z.number().finite().min(-29_999_984).max(29_999_984),
    y: z.number().finite().min(-2_032).max(2_032),
    z: z.number().finite().min(-29_999_984).max(29_999_984),
    world: z.string().trim().max(128).regex(/^[a-z0-9_.:-]+$/i, 'World has unsupported characters.').optional(),
  }).optional(),
  inventory: z.array(z.object({
    slot: z.number().int().min(-106).max(255),
    itemId: z.string().trim().max(160).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i, 'Item IDs must be namespaced Minecraft item IDs.').optional(),
    count: z.number().int().min(0).max(64).optional(),
  })).min(1).max(64).optional(),
}).superRefine((value, context) => {
  if (value.action === 'gamemode' && !value.gamemode) context.addIssue({ code: z.ZodIssueCode.custom, path: ['gamemode'], message: 'Choose a game mode.' });
  if (value.action === 'teleport' && !value.teleport) context.addIssue({ code: z.ZodIssueCode.custom, path: ['teleport'], message: 'Provide teleport coordinates.' });
  if (value.action === 'inventory' && !value.inventory) context.addIssue({ code: z.ZodIssueCode.custom, path: ['inventory'], message: 'Provide inventory changes.' });
});

function isAllowedRequestOrigin(origin: string | undefined): boolean {
  return isAllowedOrigin(origin, config.host);
}

function publicStatus(status: ServerStatus): ServerStatus | 'stopped' {
  if (status === 'offline') return 'stopped';
  if (status === 'installing') return 'starting';
  return status;
}

function selectedSoftware(input: { software?: ProvisionableServerSoftware; flavor?: 'vanilla' | 'paper' }): ProvisionableServerSoftware {
  const software = input.software ?? input.flavor;
  if (!software) throw new AppError(400, 'software_required', 'Choose a Minecraft server software implementation.');
  return software;
}

function serializeServer(server: ServerRecord, directoryExists = true) {
  return {
    id: server.id,
    machineId: server.machineId,
    name: server.name,
    game: server.game ?? (server.software === 'bedrock' ? 'minecraft-bedrock' : 'minecraft-java'),
    flavor: server.flavor,
    software: server.software,
    distribution: server.software,
    version: server.version,
    loaderVersion: server.loaderVersion,
    startupConfig: server.startupConfig,
    status: publicStatus(server.status),
    installState: server.installState,
    port: server.port,
    memoryMb: server.memoryMb,
    memory: { limitBytes: server.memoryMb * 1024 * 1024 },
    eulaAccepted: server.eulaAccepted,
    requiredJavaMajor: server.requiredJavaMajor,
    javaPath: server.javaPath,
    autoStart: server.autoStart ?? 'disabled',
    directory: server.directory,
    directoryExists,
    error: server.lastError,
    lastError: server.lastError,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    lastStartedAt: server.lastStartedAt,
    lastStoppedAt: server.lastStoppedAt,
  };
}

async function serializeServerWithDiskCheck(server: ServerRecord, serversDirectory: string) {
  const directoryExists = await managedServerDirectoryExists(serversDirectory, server.directory);
  return serializeServer(server, directoryExists);
}

function requireServer(repository: ServerRepository, id: string): ServerRecord {
  const server = repository.find(id);
  if (!server) throw new AppError(404, 'server_not_found', 'The requested server does not exist.');
  return server;
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    const cleanUp = () => {
      probe.removeAllListeners();
      probe.close(() => resolve());
    };
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.removeAllListeners();
      if (error.code === 'EADDRINUSE') {
        reject(new AppError(409, 'port_in_use', `Port ${port} is already occupied on this computer.`));
      } else {
        reject(new AppError(500, 'port_check_failed', `NodePilot could not test port ${port}: ${error.message}`));
      }
    });
    probe.once('listening', cleanUp);
    probe.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

async function chooseGamePort(repository: ServerRepository, requestedPort?: number, isBedrock = false): Promise<number> {
  if (requestedPort !== undefined) {
    if (repository.portIsAssigned(requestedPort)) {
      throw new AppError(409, 'port_assigned', `Port ${requestedPort} is already assigned to another managed server.`);
    }
    await assertPortAvailable(requestedPort);
    return requestedPort;
  }

  // Prefer the conventional Minecraft port, then move through a bounded nearby range. The
  // later bind error from Java is still handled since no preflight can eliminate this race.
  const startPort = isBedrock ? 19_132 : 25_565;
  const endPort = startPort + 100;
  for (let port = startPort; port <= endPort; port += 1) {
    if (repository.portIsAssigned(port)) continue;
    try {
      await assertPortAvailable(port);
      return port;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'port_in_use') throw error;
    }
  }
  throw new AppError(409, 'no_port_available', `NodePilot could not find a free Minecraft port between ${startPort} and ${endPort}. Choose a port manually.`);
}

async function clientBuildExists(): Promise<boolean> {
  try {
    await access(path.join(config.clientDistDirectory, 'index.html'));
    return true;
  } catch {
    return false;
  }
}

interface BuildAppOptions {
  instanceLock?: InstanceLock;
  isPrimaryInstance?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  await ensureDirectory(config.serversDirectory);
  await ensureDirectory(config.importsDirectory);
  await ensureDirectory(config.backupsDirectory);
  const database = openDatabase(config.databasePath);
  const repository = new ServerRepository(database);
  repository.markInterruptedProcessesOffline();
  const hostSettings = new HostSettingsRepository(database);
  const updates = new UpdateService(config.dataDirectory, config.projectDirectory, hostSettings, repository);
  updates.start();
  const startup = new StartupService(hostSettings, path.resolve('.'));
  const playit = new PlayitService(config.dataDirectory);
  const serverTunnelRepo = new ServerTunnelRepository(database);
  const settingsRepository = new ServerSettingsRepository(database);
  const serverTunnels = new ServerTunnelService(serverTunnelRepo, repository, playit, settingsRepository);
  const minecraft = new MinecraftService(repository, config.serversDirectory);
  const java = new JavaService(config.dataDirectory);
  const runtime = new ServerRuntime(repository, config.serversDirectory, settingsRepository);
  const autoStart = new AutoStartService(repository, runtime, playit, java);
  const metrics = new ProcessMetricsService(runtime, config.serversDirectory);
  const files = new FileService(config.serversDirectory);
  const importer = new ImportService(config.serversDirectory, config.dataDirectory);
  const addons = new AddonService(config.serversDirectory, config.backupsDirectory, database);
  const bridge = new PlayerBridgeManager(database);
  const players = new PlayerService(config.serversDirectory, runtime, bridge);
  const autoSleep = new AutoSleepService(repository, settingsRepository, runtime, players);
  autoSleep.start();
  const wakeProxy = new WakeProxyService(repository, settingsRepository, serverTunnelRepo, playit, runtime, java);
  wakeProxy.start();
  const system = new SystemService(repository, config.dataDirectory);
  const app = Fastify({ logger: { level: process.env.NODEPILOT_LOG_LEVEL ?? 'info' }, bodyLimit: 1_100_000 });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, isAllowedRequestOrigin(origin)),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });
  await app.register(websocket, { options: { maxPayload: 16_384 } });
  await app.register(multipart, {
    limits: { files: 1, fileSize: MAX_IMPORT_ARCHIVE_BYTES, fields: 4, parts: 5 },
    throwFileSizeLimit: true,
  });

  app.addHook('preHandler', async (request) => {
    if (!config.pin) return;
    const urlPath = request.url.split('?')[0];
    if (
      !urlPath.startsWith('/api/') ||
      urlPath.startsWith('/api/auth/') ||
      urlPath === '/api/network' ||
      urlPath === '/api/bridge/connect'
    ) {
      return;
    }

    const queryPin = (request.query as Record<string, string> | undefined)?.pin;
    const headerPin = request.headers['x-nodepilot-pin'] as string | undefined;
    const providedPin = (headerPin ?? queryPin)?.trim();
    if (providedPin && providedPin === config.pin) {
      return;
    }

    throw new AppError(401, 'pin_required', 'Access PIN required to control NodePilot remotely.');
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = asAppError(error);
    if (appError.statusCode >= 500) request.log.error({ err: error, code: appError.code }, appError.message);
    reply.status(appError.statusCode).send({
      error: appError.code,
      message: appError.message,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    });
  });

  app.get('/api/health', async () => ({ ok: true, timestamp: new Date().toISOString(), version: '0.1.0' }));
  app.get('/api/system', async () => system.summary());
  app.get('/api/dashboard', async () => ({
    servers: await Promise.all(repository.list().map((server) => serializeServerWithDiskCheck(server, config.serversDirectory))),
    system: await system.summary(),
  }));
  app.get('/api/java', async () => ({ installations: await java.list() }));
  app.get('/api/java/downloadable', async () => {
    const installations = await java.list();
    const installedMajors = Array.from(new Set(installations.map((item) => item.major)));
    return {
      versions: java.getDownloadableMajors(),
      installedMajors,
    };
  });
  app.post('/api/java/install', async (request) => {
    const { major } = installJavaSchema.parse(request.body);
    const installation = await java.downloadAndInstall(major);
    return { ok: true, installation };
  });

  app.get('/api/minecraft/versions', async (request) => {
    const input = versionQuerySchema.parse(request.query);
    return { versions: await minecraft.getVersions(selectedSoftware(input)) };
  });
  app.get('/api/minecraft/requirements', async (request) => {
    const input = requirementsQuerySchema.parse(request.query);
    const software = selectedSoftware(input);
    await minecraft.assertVersionAvailable(software, input.version);
    const requiredJavaMajor = await minecraft.getRequiredJavaMajor(software, input.version);
    const installations = await java.list();
    const compatibleJava = requiredJavaMajor
      ? installations.filter((installation) => installation.major >= requiredJavaMajor)
      : installations;
    return {
      requiredJavaMajor,
      compatibleJava,
      message: compatibleJava.length
        ? undefined
        : requiredJavaMajor
          ? `Install Java ${requiredJavaMajor} (or a newer compatible runtime) before creating this server.`
          : 'No Java installation was detected. Install a compatible Java runtime before creating this server.',
    };
  });

  app.get('/api/servers', async () => ({
    servers: await Promise.all(repository.list().map((server) => serializeServerWithDiskCheck(server, config.serversDirectory))),
  }));
  app.get('/api/servers/:id', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    return { server: await serializeServerWithDiskCheck(requireServer(repository, id), config.serversDirectory) };
  });
  const uploadedImports = new Map<string, { path: string; createdAt: number }>();
  app.post('/api/imports/inspect-directory', async (request) => {
    const { path: sourcePath } = importDirectorySchema.parse(request.body);
    return { inspection: await importer.inspectDirectory(sourcePath) };
  });
  app.post('/api/imports/upload-archive', async (request) => {
    const upload = await request.file();
    if (!upload?.filename) throw new AppError(400, 'archive_required', 'Choose a ZIP archive to import.');
    if (!/\.zip$/i.test(upload.filename)) throw new AppError(400, 'invalid_archive_type', 'Only .zip archive uploads are supported.');
    const uploadId = crypto.randomUUID();
    const archivePath = path.join(config.importsDirectory, `${uploadId}.zip`);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_IMPORT_ARCHIVE_BYTES) callback(new AppError(413, 'archive_too_large', 'The ZIP archive exceeds NodePilot’s 4 GB upload limit.'));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(upload.file, limiter, createWriteStream(archivePath, { flags: 'wx' }));
      if (upload.file.truncated) throw new AppError(413, 'archive_too_large', 'The ZIP archive exceeds NodePilot’s 4 GB upload limit.');
      const inspection = await importer.inspectArchive(archivePath, upload.filename);
      uploadedImports.set(uploadId, { path: archivePath, createdAt: Date.now() });
      return { uploadId, inspection };
    } catch (error) {
      await rm(archivePath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  app.post('/api/imports', async (request, reply) => {
    const input = importServerSchema.parse(request.body);
    const software = selectedSoftware(input);
    const source = input.source.type === 'directory'
      ? { type: 'directory' as const, path: input.source.path }
      : (() => {
        const uploaded = uploadedImports.get(input.source.uploadId);
        if (!uploaded) throw new AppError(404, 'import_upload_not_found', 'This ZIP upload is no longer available. Upload it again.');
        return { type: 'archive' as const, path: uploaded.path };
      })();
    const inspected = await importer.prepare(source);
    const version = input.version || inspected.inspection.minecraftVersion || 'unknown';
    let port: number;
    if (input.port !== undefined) {
      port = await chooseGamePort(repository, input.port);
    } else if (inspected.inspection.port !== undefined) {
      try {
        port = await chooseGamePort(repository, inspected.inspection.port);
      } catch (error) {
        if (!(error instanceof AppError) || !['port_in_use', 'port_assigned'].includes(error.code)) throw error;
        port = await chooseGamePort(repository);
      }
    } else {
      port = await chooseGamePort(repository);
    }
    const id = crypto.randomUUID();
    const directory = safeDirectoryName(input.name, id);
    let created: ServerRecord | undefined;
    try {
      const copied = await importer.copyIntoManagedServer(source, directory, input.eulaAccepted, port);
      const requiredJavaMajor = importer.requiredJavaMajor(version);
      created = repository.create({
        id,
        machineId: 'local',
        name: input.name,
        directory,
        flavor: software === 'paper' ? 'paper' : 'vanilla',
        software,
        version,
        loaderVersion: copied.inspection.detectedSoftware === software ? copied.loaderVersion : null,
        startupConfig: copied.inspection.detectedSoftware === software || copied.startupConfig.mode === 'arg-files'
          ? copied.startupConfig
          : undefined,
        requiredJavaMajor,
        port,
        memoryMb: input.memoryMb,
        eulaAccepted: true,
      });
      const usableJava = await java.findUsable(requiredJavaMajor);
      if (usableJava) created = repository.update(id, { javaPath: usableJava.installation.path });
      const ready = repository.markReady(id);
      if (source.type === 'archive') {
        uploadedImports.delete(input.source.type === 'archive' ? input.source.uploadId : '');
        await rm(source.path, { force: true }).catch(() => undefined);
      }
      return reply.code(201).send({ server: serializeServer(ready), inspection: copied.inspection, warnings: copied.warnings, javaWarning: usableJava?.warning });
    } catch (error) {
      if (created) repository.markInstallFailed(id, errorMessage(error));
      else await rm(path.join(config.serversDirectory, directory), { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
      throw error;
    }
  });
  app.post('/api/servers', async (request, reply) => {
    const input = createServerSchema.parse(request.body);
    const software = selectedSoftware(input);
    await minecraft.assertVersionAvailable(software, input.version);
    const requiredJavaMajor = await minecraft.getRequiredJavaMajor(software, input.version);
    let usableJava: { installation: { path: string }; warning?: string } | null = null;
    if (software !== 'bedrock') {
      usableJava = await java.findUsable(requiredJavaMajor, input.javaPath);
      if (!usableJava) {
        throw new AppError(422, 'java_missing', requiredJavaMajor
          ? `Java ${requiredJavaMajor} is required for this Minecraft version. Install it, then refresh Java detection.`
          : 'No usable Java installation was found. Install Java, then refresh Java detection.');
      }
    }
    const isBedrock = software === 'bedrock';
    const port = await chooseGamePort(repository, input.port, isBedrock);
    const id = crypto.randomUUID();
    const directory = `${input.name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'minecraft-server'}-${id.slice(0, 8)}`;
    let created: ServerRecord | undefined;
    try {
      created = repository.create({
        id,
        machineId: 'local',
        name: input.name,
        directory,
        game: isBedrock ? 'minecraft-bedrock' : 'minecraft-java',
        flavor: software === 'paper' ? 'paper' : 'vanilla',
        software,
        version: input.version,
        requiredJavaMajor,
        port,
        memoryMb: input.memoryMb,
        eulaAccepted: input.eulaAccepted,
      });
      if (usableJava) {
        created = repository.update(id, { javaPath: usableJava.installation.path });
      }
      const installed = await minecraft.install(created);
      created = repository.setRuntimeConfiguration(id, installed);
      const ready = repository.markReady(id);

      if (input.enablePlayit) {
        try {
          await serverTunnels.reconcile(id, port);
        } catch {
          // As required: "If Playit setup fails, do not delete the newly created Minecraft server. Keep the server usable locally"
        }
      }

      return reply.code(201).send({ server: serializeServer(ready), javaWarning: usableJava?.warning });
    } catch (error) {
      if (created) repository.markInstallFailed(id, errorMessage(error));
      throw error;
    }
  });
  app.patch('/api/servers/:id', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const current = requireServer(repository, id);
    const input = updateServerSchema.parse(request.body);
    if ((input.port !== undefined && input.port !== current.port) || input.memoryMb !== undefined) {
      if (['starting', 'running', 'stopping'].includes(current.status)) {
        throw new AppError(409, 'server_active', 'Stop the server before changing its port or memory allocation.');
      }
    }
    if (input.port !== undefined && input.port !== current.port) {
      if (repository.portIsAssigned(input.port, id)) throw new AppError(409, 'port_assigned', `Port ${input.port} is assigned to another managed server.`);
      await assertPortAvailable(input.port);
    }
    if (input.javaPath !== undefined && input.javaPath !== null) {
      const discovered = await java.list();
      if (!discovered.some((installation) => installation.path === input.javaPath)) {
        throw new AppError(422, 'java_not_detected', 'Select a Java installation detected by NodePilot.');
      }
    }
    const updated = repository.update(id, input);
    if (input.port !== undefined && input.port !== current.port) {
      await serverTunnels.handlePortChanged(id, input.port).catch(() => undefined);
    }
    return { server: await serializeServerWithDiskCheck(updated, config.serversDirectory) };
  });
  app.delete('/api/servers/:id', async (request, reply) => {
    const { id } = serverParamsSchema.parse(request.params);
    const server = requireServer(repository, id);
    if (['starting', 'running', 'stopping'].includes(server.status)) {
      if (runtime.isProcessActive(server.id)) {
        throw new AppError(409, 'server_active', 'Stop the server before deleting it.');
      }
    }
    try {
      const target = await resolveManagedServerRoot(config.serversDirectory, server.directory);
      await rm(target, { recursive: true, force: true, maxRetries: 2 });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'server_directory_not_found') {
        throw error;
      }
    }
    await serverTunnels.remove(id).catch(() => undefined);
    repository.delete(id);
    return reply.code(204).send();
  });

  async function runLifecycle(request: FastifyRequest, action: 'start' | 'stop' | 'restart') {
    const { id } = serverParamsSchema.parse(request.params);
    if (updates.isRestartScheduled() && action !== 'stop') {
      throw new AppError(409, 'update_restarting', 'NodePilot is applying an update. Wait for it to restart before starting a server.');
    }
    let server = requireServer(repository, id);
    if (action === 'stop') return { server: await serializeServerWithDiskCheck(await runtime.stop(server), config.serversDirectory) };
    const directoryExists = await managedServerDirectoryExists(config.serversDirectory, server.directory);
    if (!directoryExists) {
      throw new AppError(404, 'server_directory_not_found', 'The server directory does not exist on disk.');
    }
    const isBedrock = server.software === 'bedrock' || server.startupConfig.mode === 'executable';
    let javaPath: string | undefined;
    let warning: string | undefined;
    if (!isBedrock) {
      const usableJava = await java.findUsable(server.requiredJavaMajor, server.javaPath);
      if (!usableJava) {
        throw new AppError(422, 'java_missing', server.requiredJavaMajor
          ? `Java ${server.requiredJavaMajor} is required to start this server.`
          : 'No usable Java installation was found to start this server.');
      }
      if (server.javaPath !== usableJava.installation.path) server = repository.update(server.id, { javaPath: usableJava.installation.path });
      javaPath = usableJava.installation.path;
      warning = usableJava.warning;
    }
    const updated = action === 'start'
      ? await runtime.start(server, javaPath, warning)
      : await runtime.restart(server, javaPath, warning);

    if (action === 'start' || action === 'restart') {
      const associatedTunnel = serverTunnelRepo.find(server.id);
      if (associatedTunnel) {
        serverTunnels.reconcile(server.id, server.port).catch(() => undefined);
      }
    }

    return { server: await serializeServerWithDiskCheck(updated, config.serversDirectory) };
  }
  app.post('/api/servers/:id/start', async (request) => runLifecycle(request, 'start'));
  app.post('/api/servers/:id/stop', async (request) => runLifecycle(request, 'stop'));
  app.post('/api/servers/:id/restart', async (request) => runLifecycle(request, 'restart'));
  app.post('/api/servers/:id/command', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    requireServer(repository, id);
    const { command } = commandSchema.parse(request.body);
    runtime.sendCommand(id, command);
    return { ok: true };
  });
  app.get('/api/servers/:id/logs', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    requireServer(repository, id);
    const { tail } = logsQuerySchema.parse(request.query);
    return { logs: runtime.getLogs(id, tail) };
  });
  app.get('/api/servers/:id/usage', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const usage = await metrics.usage(requireServer(repository, id));
    return { ...usage, status: publicStatus(usage.status) };
  });
  app.get('/api/servers/:id/properties', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    return { properties: await files.getProperties(requireServer(repository, id)) };
  });
  app.put('/api/servers/:id/properties', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const { values } = propertiesSchema.parse(request.body);
    return { properties: await files.saveProperties(requireServer(repository, id), values) };
  });
  app.get('/api/servers/:id/files', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const { path: requestedPath } = filePathQuerySchema.parse(request.query);
    return { files: await files.list(requireServer(repository, id), requestedPath) };
  });
  app.get('/api/servers/:id/files/content', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const { path: requestedPath } = z.object({ path: z.string().min(1).max(512) }).parse(request.query);
    return { file: await files.readText(requireServer(repository, id), requestedPath) };
  });
  app.put('/api/servers/:id/files/content', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = fileContentSchema.parse(request.body);
    return { file: await files.writeText(requireServer(repository, id), input.path, input.content) };
  });
  app.post('/api/servers/:id/files/rename', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = fileRenameSchema.parse(request.body);
    return { file: await files.rename(requireServer(repository, id), input.path, input.newName) };
  });
  app.delete('/api/servers/:id/files', async (request, reply) => {
    const { id } = serverParamsSchema.parse(request.params);
    const query = request.query as Record<string, unknown> | undefined;
    const body = request.body as Record<string, unknown> | undefined;
    const targetPath = typeof query?.path === 'string' && query.path ? query.path : typeof body?.path === 'string' ? body.path : '';
    const { path: validPath } = fileDeleteSchema.parse({ path: targetPath });
    await files.delete(requireServer(repository, id), validPath);
    return reply.code(204).send();
  });
  app.post('/api/servers/:id/files/copy', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = fileCopySchema.parse(request.body);
    return { file: await files.copy(requireServer(repository, id), input.sourcePath, input.destinationDir) };
  });
  app.post('/api/servers/:id/files/move', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = fileMoveSchema.parse(request.body);
    return { file: await files.move(requireServer(repository, id), input.sourcePath, input.destinationDir) };
  });
  app.post('/api/servers/:id/files/create-file', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = fileCreateFileSchema.parse(request.body);
    return { file: await files.createFile(requireServer(repository, id), input.parentPath, input.name, input.content) };
  });
  app.post('/api/servers/:id/files/create-folder', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = fileCreateFolderSchema.parse(request.body);
    return { folder: await files.createFolder(requireServer(repository, id), input.parentPath, input.name) };
  });

  app.get('/api/servers/:id/addons', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    return addons.list(requireServer(repository, id));
  });
  app.get('/api/servers/:id/addons/search', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = addonSearchQuerySchema.parse(request.query);
    return { results: await addons.search(requireServer(repository, id), input.type, input.source, input.query) };
  });
  app.get('/api/servers/:id/addons/updates', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    return { updates: await addons.checkUpdates(requireServer(repository, id)) };
  });
  app.post('/api/servers/:id/addons/modrinth', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = addonInstallSchema.parse(request.body);
    const result = await addons.installModrinth(requireServer(repository, id), input.type, input.projectId, input.allowMissingDependencies);
    return { ...result, restartRequired: true };
  });
  app.post('/api/servers/:id/addons/hangar', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = hangarInstallSchema.parse(request.body);
    const result = await addons.installHangar(requireServer(repository, id), input.projectId);
    return { ...result, restartRequired: true };
  });
  app.post('/api/servers/:id/addons/upload', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const { type } = addonUploadQuerySchema.parse(request.query);
    const upload = await request.file();
    if (!upload?.filename) throw new AppError(400, 'addon_required', 'Choose a .jar add-on file to upload.');
    if (!/\.jar$/i.test(upload.filename)) throw new AppError(400, 'invalid_addon_filename', 'Only .jar add-on uploads are supported.');
    const stagedPath = path.join(config.importsDirectory, `addon-${crypto.randomUUID()}.jar`);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_ADDON_UPLOAD_BYTES) callback(new AppError(413, 'addon_too_large', 'Uploaded add-ons are limited to 256 MB.'));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(upload.file, limiter, createWriteStream(stagedPath, { flags: 'wx' }));
      if (upload.file.truncated) throw new AppError(413, 'addon_too_large', 'Uploaded add-ons are limited to 256 MB.');
      const result = await addons.installUpload(requireServer(repository, id), type, stagedPath, upload.filename);
      return { ...result, restartRequired: true };
    } finally {
      await rm(stagedPath, { force: true }).catch(() => undefined);
    }
  });
  app.post('/api/servers/:id/addons/update', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = addonUpdateSchema.parse(request.body);
    const result = await addons.update(requireServer(repository, id), input.type, input.fileName);
    return { ...result, restartRequired: true };
  });
  app.delete('/api/servers/:id/addons/:type/:fileName', async (request) => {
    const { id, type, fileName } = addonRemoveParamsSchema.parse(request.params);
    addonRemoveSchema.parse(request.body);
    const result = await addons.remove(requireServer(repository, id), type, fileName);
    return { ...result, restartRequired: true };
  });

  app.get('/api/servers/:id/players', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    return players.list(requireServer(repository, id));
  });
  app.get('/api/servers/:id/players/bridge', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const server = requireServer(repository, id);
    return { bridge: players.bridgeStatus(server) };
  });
  app.post('/api/servers/:id/players/bridge/credentials', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const server = requireServer(repository, id);
    const credential = players.createBridgeCredentials(server);
    return {
      bridge: players.bridgeStatus(server),
      credential,
      config: {
        nodepilotUrl: `ws://127.0.0.1:${config.port}/api/bridge/connect`,
        serverId: server.id,
        token: credential.token,
      },
    };
  });
  app.post('/api/servers/:id/players/action', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const input = playerActionSchema.parse(request.body);
    const result = await players.action(requireServer(repository, id), input.player, input.action as PlayerAction, {
      reason: input.reason,
      gamemode: input.gamemode,
      teleport: input.teleport,
      inventory: input.inventory,
    });
    return result;
  });
  app.get('/api/servers/:id/players/:player', async (request) => {
    const { id, player } = playerParamsSchema.parse(request.params);
    return { player: await players.details(requireServer(repository, id), player) };
  });

  app.get('/api/auth/status', async (request) => {
    const hasPin = Boolean(config.pin);
    const providedPin = (request.headers['x-nodepilot-pin'] as string | undefined)?.trim();
    const authenticated = !hasPin || (Boolean(providedPin) && providedPin === config.pin);
    return { hasPin, authenticated };
  });

  app.post('/api/auth/verify', async (request) => {
    if (!config.pin) return { ok: true, pinRequired: false };
    const { pin } = pinVerifySchema.parse(request.body);
    if (pin.trim() !== config.pin) {
      throw new AppError(401, 'invalid_pin', 'Incorrect access PIN.');
    }
    return { ok: true, pinRequired: true };
  });

  app.get('/api/network', async () => {
    config = getConfig();
    const addresses = getLocalNetworkAddresses();
    const accessUrls = formatAccessUrls(config.host, config.port, addresses);
    const hostChanged = config.host !== currentListeningHost;
    return {
      host: config.host,
      port: config.port,
      isNetworkVisible: config.isNetworkVisible,
      addresses,
      accessUrls,
      hasPin: Boolean(config.pin),
      activeHost: currentListeningHost,
      requiresRestart: hostChanged,
    };
  });

  app.put('/api/network', async (request) => {
    const input = networkUpdateSchema.parse(request.body);
    const pin = input.pin !== undefined ? input.pin : undefined;
    await updateEnvFile({
      NODEPILOT_HOST: input.host,
      ...(pin !== undefined ? { NODEPILOT_PIN: pin } : {}),
    });

    config = getConfig();
    const hostChanged = input.host !== currentListeningHost;

    return {
      ok: true,
      requiresRestart: hostChanged,
      host: config.host,
      isNetworkVisible: config.isNetworkVisible,
      hasPin: Boolean(config.pin),
      message: hostChanged
        ? `Network mode saved to .env! To bind to ${input.host}, restart NodePilot in terminal (Ctrl+C, then npm start).`
        : 'Network settings updated successfully!',
    };
  });

  // Host Settings & OS System Startup
  app.get('/api/host/settings', async () => {
    return {
      settings: hostSettings.getSettings(),
      startup: await startup.getStatus(),
      playit: await playit.getStatus(),
    };
  });

  app.put('/api/host/settings', async (request) => {
    const input = hostSettingsUpdateSchema.parse(request.body);
    const updated = hostSettings.saveSettings(input);
    return {
      settings: updated,
      startup: await startup.getStatus(),
    };
  });

  app.get('/api/host/updates', async () => ({ update: updates.getStatus() }));

  app.post('/api/host/updates/check', async () => ({
    update: await updates.checkForUpdates(true),
  }));

  app.put('/api/host/updates/preferences', async (request) => {
    const { includePrereleases } = updatePreferencesSchema.parse(request.body);
    updates.setIncludePrereleases(includePrereleases);
    return { update: await updates.checkForUpdates(true), settings: hostSettings.getSettings() };
  });

  app.post('/api/host/updates/dismiss', async () => {
    updates.dismissAvailableRelease();
    return { update: updates.getStatus(), settings: hostSettings.getSettings() };
  });

  app.post('/api/host/updates/install', async (_request, reply) => {
    if (!options.isPrimaryInstance || !options.instanceLock) {
      throw new AppError(409, 'update_not_primary_instance', 'Only the primary NodePilot instance may apply an update.');
    }

    const prepared = await updates.prepareUpdate();
    // Respond before closing the listener. The detached helper waits for this process
    // to exit and never force-kills it, avoiding PID reuse or partial game shutdown.
    reply.raw.once('finish', () => {
      const restart = setTimeout(() => {
        void (async () => {
          try {
            updates.launchPreparedUpdate();
            await app.close();
            options.instanceLock?.release();
            process.exit(0);
          } catch (error) {
            updates.markRestartFailed(error);
            app.log.error({ err: error }, 'Unable to hand off to the NodePilot update helper');
          }
        })();
      }, 150);
      restart.unref();
    });
    return reply.code(202).send({ ...prepared, update: updates.getStatus() });
  });

  app.post('/api/host/startup/enable', async (request) => {
    const input = hostStartupEnableSchema.parse(request.body ?? {});
    const startupStatus = await startup.enableStartup(input);
    return {
      ok: true,
      startup: startupStatus,
      settings: hostSettings.getSettings(),
    };
  });

  app.post('/api/host/startup/disable', async () => {
    const startupStatus = await startup.disableStartup();
    return {
      ok: true,
      startup: startupStatus,
      settings: hostSettings.getSettings(),
    };
  });

  app.get('/api/host/playit', async () => {
    return { playit: await playit.getStatus() };
  });

  app.post('/api/host/playit/install', async () => {
    autoStart.log('info', 'Downloading official Playit.gg agent binary...');
    const status = await playit.installManagedBinary();
    autoStart.log('info', `Playit.gg binary successfully installed (${status.version ?? 'ready'}).`);
    return { ok: true, playit: status };
  });

  app.post('/api/host/playit/claim', async () => {
    const claimResult = await playit.claimAccount();
    autoStart.log('info', `Generated Playit account linking link: ${claimResult.claimUrl}`);
    return {
      ok: true,
      claimUrl: claimResult.claimUrl,
      claimCode: claimResult.claimCode,
      playit: await playit.getStatus(),
    };
  });

  app.post('/api/host/playit/start', async () => {
    const status = await playit.startAgent();
    autoStart.log('info', 'User started Playit.gg agent via Host Settings.');
    return { ok: true, playit: status };
  });

  app.post('/api/host/playit/stop', async () => {
    const status = await playit.stopAgent();
    autoStart.log('info', 'User stopped Playit.gg agent via Host Settings.');
    return { ok: true, playit: status };
  });

  app.post('/api/host/playit/secret', async (request) => {
    const { secretKey } = playitSecretSchema.parse(request.body);
    const status = await playit.setSecretKey(secretKey);
    autoStart.log('info', 'User saved Playit.gg secret key directly. Agent started.');
    return { ok: true, playit: status };
  });

  app.post('/api/host/playit/reset', async () => {
    const status = await playit.resetSecret();
    autoStart.log('info', 'User unlinked / reset Playit.gg credentials.');
    return { ok: true, playit: status };
  });

  app.get('/api/host/diagnostics', async () => {
    const memoryUsage = process.memoryUsage();
    const diagnostics: HostDiagnostics = {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      platform: `${process.platform} (${process.arch})`,
      arch: process.arch,
      memoryUsageMb: Math.round(memoryUsage.rss / 1024 / 1024),
      recentLogs: autoStart.getDiagnostics(),
    };
    return diagnostics;
  });

  app.put('/api/servers/:id/autostart', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const { autoStart: mode } = serverAutoStartSchema.parse(request.body);
    const updated = repository.setAutoStart(id, mode as AutoStartMode);
    autoStart.log('info', `Server "${updated.name}" (${updated.id}) auto-start set to "${mode}".`);
    return { ok: true, server: await serializeServerWithDiskCheck(updated, config.serversDirectory) };
  });

  // Server Playit.gg Tunnel Management
  app.get('/api/servers/:id/tunnel', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    requireServer(repository, id);
    return serverTunnels.getStatus(id);
  });

  app.post('/api/servers/:id/tunnel/enable', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    requireServer(repository, id);
    const result = await serverTunnels.enable(id);
    autoStart.log('info', `Playit tunnel integration enabled for server ID ${id}.`);
    return { ok: true, ...result };
  });

  app.post('/api/servers/:id/tunnel/verify', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    requireServer(repository, id);
    const result = await serverTunnels.verify(id);
    return { ok: true, ...result };
  });

  app.delete('/api/servers/:id/tunnel', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    requireServer(repository, id);
    const ok = await serverTunnels.remove(id);
    autoStart.log('info', `Playit tunnel association removed for server ID ${id}.`);
    return { ok };
  });

  // Server Settings (Auto-Wake, Auto-Sleep, Java & Performance, Startup & Shutdown, General)
  app.get('/api/servers/:id/settings', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    const server = requireServer(repository, id);
    const settings = settingsRepository.getOrCreate(id);
    const wakeProxyStatus = await wakeProxy.getStatus(id);
    const autoSleepStatus = autoSleep.getStatus(id);
    const playitStatus = await playit.getStatus();
    const tunnel = serverTunnelRepo.find(id);

    const isBedrock = server.software === 'bedrock' || server.game === 'minecraft-bedrock' || server.startupConfig.mode === 'executable';
    let detectedJava: JavaInstallation | null = null;
    let availableJava: JavaInstallation[] = [];

    if (!isBedrock) {
      try {
        availableJava = await java.list();
        if (server.javaPath) {
          detectedJava = availableJava.find((j) => j.path === server.javaPath) ?? null;
        }
        if (!detectedJava && server.requiredJavaMajor) {
          const usable = await java.findUsable(server.requiredJavaMajor, server.javaPath);
          if (usable) {
            detectedJava = usable.installation;
          }
        }
      } catch {
        // ignore discovery failures
      }
    }

    return {
      settings: {
        serverId: server.id,
        autoWake: settings.autoWake,
        wakeProxyPort: settings.wakeProxyPort,
        autoSleep: settings.autoSleep,
        idleTimeoutMinutes: settings.idleTimeoutMinutes,
        minMemoryMb: settings.minMemoryMb,
        maxMemoryMb: server.memoryMb,
        customJvmArgs: settings.customJvmArgs,
        autoStart: server.autoStart ?? 'disabled',
        shutdownTimeoutSeconds: settings.shutdownTimeoutSeconds,
        createdAt: settings.createdAt,
        updatedAt: settings.updatedAt,
      },
      runtime: {
        status: publicStatus(server.status),
        isRunning: ['starting', 'running', 'stopping'].includes(server.status),
        isBedrock,
        software: server.software,
        flavor: server.flavor,
        version: server.version,
        loaderVersion: server.loaderVersion,
        startupConfig: server.startupConfig,
        port: server.port,
        directory: server.directory,
        javaPath: server.javaPath,
        requiredJavaMajor: server.requiredJavaMajor,
        detectedJava,
        availableJava,
        wakeProxy: wakeProxyStatus,
        autoSleep: autoSleepStatus,
        playit: playitStatus,
        tunnel,
      },
    };
  });

  app.put('/api/servers/:id/settings', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    let server = requireServer(repository, id);
    const currentSettings = settingsRepository.getOrCreate(id);
    const input = updateServerSettingsSchema.parse(request.body);

    const isServerActive = ['starting', 'running', 'stopping'].includes(server.status);
    let restartRequired = false;

    // 1. Port validation
    if (input.port !== undefined && input.port !== server.port) {
      if (isServerActive) {
        throw new AppError(409, 'server_active', 'Stop the server before changing its port.');
      }
      if (repository.portIsAssigned(input.port, id)) {
        throw new AppError(409, 'port_assigned', `Port ${input.port} is assigned to another managed server.`);
      }
      await assertPortAvailable(input.port);
    }

    // 2. Wake Proxy Port validation
    const targetServerPort = input.port ?? server.port;
    if (input.wakeProxyPort !== undefined && input.wakeProxyPort !== null) {
      if (input.wakeProxyPort === targetServerPort) {
        throw new AppError(400, 'wake_port_conflict', `Wake proxy port (${input.wakeProxyPort}) cannot be identical to the Minecraft server port.`);
      }
    }

    // 3. Memory validation & parsing
    let parsedMinMb: number | null | undefined = undefined;
    if (input.minMemory !== undefined) {
      parsedMinMb = parseMemoryMb(input.minMemory);
    } else if (input.minMemoryMb !== undefined) {
      parsedMinMb = input.minMemoryMb;
    }

    let parsedMaxMb: number | undefined = undefined;
    if (input.maxMemory !== undefined) {
      parsedMaxMb = parseMemoryMb(input.maxMemory) ?? undefined;
    } else if (input.maxMemoryMb !== undefined) {
      parsedMaxMb = input.maxMemoryMb;
    }

    const effectiveMaxMb = parsedMaxMb ?? server.memoryMb;
    const effectiveMinMb = parsedMinMb !== undefined ? parsedMinMb : currentSettings.minMemoryMb;

    if (effectiveMinMb !== null && effectiveMinMb !== undefined && effectiveMinMb > effectiveMaxMb) {
      throw new AppError(
        400,
        'min_memory_exceeds_max',
        `Minimum heap allocation (${effectiveMinMb} MB) cannot exceed maximum heap allocation (${effectiveMaxMb} MB).`,
      );
    }

    // 4. Custom JVM Arguments validation
    let validatedJvmArgs: string[] | undefined = undefined;
    if (input.customJvmArgs !== undefined) {
      validatedJvmArgs = validateCustomJvmArgs(input.customJvmArgs);
    }

    // 5. Check if changes require restart
    if (isServerActive) {
      if (parsedMaxMb !== undefined && parsedMaxMb !== server.memoryMb) {
        restartRequired = true;
      }
      if (parsedMinMb !== undefined && parsedMinMb !== currentSettings.minMemoryMb) {
        restartRequired = true;
      }
      if (
        validatedJvmArgs !== undefined &&
        JSON.stringify(validatedJvmArgs) !== JSON.stringify(currentSettings.customJvmArgs)
      ) {
        restartRequired = true;
      }
      if (
        input.shutdownTimeoutSeconds !== undefined &&
        input.shutdownTimeoutSeconds !== currentSettings.shutdownTimeoutSeconds
      ) {
        restartRequired = true;
      }
    }

    // 6. Apply updates
    if (input.name !== undefined && input.name !== server.name) {
      server = repository.update(id, { name: input.name });
    }
    if (input.port !== undefined && input.port !== server.port) {
      server = repository.update(id, { port: input.port });
      await serverTunnels.handlePortChanged(id, input.port).catch(() => undefined);
    }
    if (parsedMaxMb !== undefined && parsedMaxMb !== server.memoryMb) {
      server = repository.update(id, { memoryMb: parsedMaxMb });
    }
    if (input.autoStart !== undefined && input.autoStart !== server.autoStart) {
      server = repository.setAutoStart(id, input.autoStart);
    }

    const updatedSettings = settingsRepository.update(id, {
      autoWake: input.autoWake,
      wakeProxyPort: input.wakeProxyPort,
      autoSleep: input.autoSleep,
      idleTimeoutMinutes: input.idleTimeoutMinutes,
      minMemoryMb: parsedMinMb,
      customJvmArgs: validatedJvmArgs,
      shutdownTimeoutSeconds: input.shutdownTimeoutSeconds,
    });

    void wakeProxy.reconcileAll();

    const wakeProxyStatus = await wakeProxy.getStatus(id);
    const autoSleepStatus = autoSleep.getStatus(id);
    const playitStatus = await playit.getStatus();
    const tunnel = serverTunnelRepo.find(id);

    return {
      ok: true,
      restartRequired,
      settings: {
        serverId: server.id,
        autoWake: updatedSettings.autoWake,
        wakeProxyPort: updatedSettings.wakeProxyPort,
        autoSleep: updatedSettings.autoSleep,
        idleTimeoutMinutes: updatedSettings.idleTimeoutMinutes,
        minMemoryMb: updatedSettings.minMemoryMb,
        maxMemoryMb: server.memoryMb,
        customJvmArgs: updatedSettings.customJvmArgs,
        autoStart: server.autoStart ?? 'disabled',
        shutdownTimeoutSeconds: updatedSettings.shutdownTimeoutSeconds,
        createdAt: updatedSettings.createdAt,
        updatedAt: updatedSettings.updatedAt,
      },
      runtime: {
        status: publicStatus(server.status),
        isRunning: isServerActive,
        port: server.port,
        wakeProxy: wakeProxyStatus,
        autoSleep: autoSleepStatus,
        playit: playitStatus,
        tunnel,
      },
    };
  });

  app.post('/api/servers/:id/settings/reset', async (request) => {
    const { id } = serverParamsSchema.parse(request.params);
    let server = requireServer(repository, id);
    const { section } = resetServerSettingsSchema.parse(request.body);

    const updatedSettings = settingsRepository.resetSection(id, section);
    if (section === 'startup') {
      server = repository.setAutoStart(id, 'disabled');
    }

    void wakeProxy.reconcileAll();

    const wakeProxyStatus = await wakeProxy.getStatus(id);
    const autoSleepStatus = autoSleep.getStatus(id);
    const playitStatus = await playit.getStatus();
    const tunnel = serverTunnelRepo.find(id);

    return {
      ok: true,
      settings: {
        serverId: server.id,
        autoWake: updatedSettings.autoWake,
        wakeProxyPort: updatedSettings.wakeProxyPort,
        autoSleep: updatedSettings.autoSleep,
        idleTimeoutMinutes: updatedSettings.idleTimeoutMinutes,
        minMemoryMb: updatedSettings.minMemoryMb,
        maxMemoryMb: server.memoryMb,
        customJvmArgs: updatedSettings.customJvmArgs,
        autoStart: server.autoStart ?? 'disabled',
        shutdownTimeoutSeconds: updatedSettings.shutdownTimeoutSeconds,
        createdAt: updatedSettings.createdAt,
        updatedAt: updatedSettings.updatedAt,
      },
      runtime: {
        status: publicStatus(server.status),
        isRunning: ['starting', 'running', 'stopping'].includes(server.status),
        port: server.port,
        wakeProxy: wakeProxyStatus,
        autoSleep: autoSleepStatus,
        playit: playitStatus,
        tunnel,
      },
    };
  });

  app.get('/api/bridge/connect', { websocket: true }, (socket, request) => {
    if (!isAllowedRequestOrigin(request.headers.origin)) {
      socket.close(1008, 'Origin not permitted');
      return;
    }
    bridge.accept(socket);
  });

  app.get('/api/servers/:id/console', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    let server: ServerRecord;
    try {
      if (!isAllowedRequestOrigin(origin)) {
        socket.close(1008, 'Origin not permitted');
        return;
      }
      const pin = (request.query as Record<string, string> | undefined)?.pin ?? (request.headers['x-nodepilot-pin'] as string | undefined);
      if (config.pin && (!pin || pin.trim() !== config.pin)) {
        socket.close(1008, 'PIN required');
        return;
      }
      const { id } = serverParamsSchema.parse(request.params);
      server = requireServer(repository, id);
    } catch {
      socket.close(1008, 'Invalid server');
      return;
    }
    const serverId = server.id;
    const send = (payload: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };
    send({ type: 'snapshot', serverId, status: publicStatus(server.status), logs: runtime.getLogs(serverId, 400) });
    const onEvent = (event: { serverId: string }) => { if (event.serverId === serverId) send(event); };
    runtime.on('event', onEvent);
    socket.on('message', (raw: Buffer) => {
      try {
        const text = raw.toString();
        if (text.length > 4_096) throw new AppError(400, 'invalid_console_message', 'Console messages are too large.');
        const parsed = z.object({ type: z.literal('command'), command: z.string().min(1).max(500) }).parse(JSON.parse(text));
        runtime.sendCommand(serverId, parsed.command);
      } catch (error) {
        const appError = asAppError(error);
        send({ type: 'error', code: appError.code, message: appError.message });
      }
    });
    socket.once('close', () => runtime.off('event', onEvent));
    socket.once('error', () => runtime.off('event', onEvent));
  });

  if (await clientBuildExists()) {
    await app.register(fastifyStatic, { root: config.clientDistDirectory });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found', message: 'The requested API resource was not found.' });
      }
      if (request.method === 'GET' && (request.headers.accept?.includes('text/html') || !path.extname(request.url))) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found', message: 'The requested resource was not found.' });
    });
  } else {
    app.get('/', async () => ({ name: 'NodePilot', message: 'The browser app has not been built. Run npm run build.' }));
  }

  app.decorate('autoStart', autoStart);
  app.addHook('onClose', async () => {
    updates.stop();
    autoSleep.stop();
    wakeProxy.stop();
    bridge.shutdown();
    await metrics.shutdown();
    await runtime.shutdown();
    database.close();
  });
  return app;
}

if (await shouldRunFirstTimeSetup()) {
  await runInteractiveSetup();
  config = getConfig();
}

const instanceLock = new InstanceLock(config.dataDirectory);
const lockAcquired = await instanceLock.acquire();
if (!lockAcquired) {
  console.warn('\n⚠️  Another instance of NodePilot appears to be running on this machine.');
  console.warn('   If you are starting NodePilot again, check your existing process or system startup service.\n');
}

const app = await buildApp({ instanceLock, isPrimaryInstance: lockAcquired });
try {
  currentListeningHost = config.host;
  await app.listen({ host: config.host, port: config.port });
  const addresses = getLocalNetworkAddresses();
  console.log('\n============================================================');
  console.log('  🚀 NodePilot is running!');
  console.log('============================================================');
  console.log(`  ➜ Local:   http://localhost:${config.port}`);
  if (config.isNetworkVisible && addresses.length > 0) {
    for (const ip of addresses) {
      console.log(`  ➜ Network: http://${ip}:${config.port}`);
    }
    console.log('\n  Mode: Local Network (LAN)');
    console.log('  👉 Open the Network URL on your main laptop or phone!');
  } else {
    console.log('  Mode: Local PC only (127.0.0.1)');
    console.log('  (Run "npm run setup" to make visible on your local network)');
  }
  if (config.pin) {
    console.log('  🔒 Security PIN: Active');
  }
  console.log('============================================================\n');

  // Trigger auto-start for servers and Playit after port listening is established
  void (app as unknown as { autoStart: AutoStartService }).autoStart.runBootSequence();
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
  instanceLock.release();
}

process.once('SIGINT', () => {
  instanceLock.release();
});
process.once('SIGTERM', () => {
  instanceLock.release();
});
