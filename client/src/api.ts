import type {
  CreateServerInput,
  ConsoleLine,
  DashboardData,
  FileContent,
  FileEntry,
  JavaDiscovery,
  MinecraftRequirements,
  MinecraftVersion,
  Server,
  ServerProperties,
  SystemMetrics,
  UpdateServerInput,
  ImportInspection,
  ImportServerInput,
  AddonCatalogResult,
  AddonList,
  AddonType,
  AddonUpdate,
  ManagedPlayer,
  PlayerAction,
  PlayerActionInput,
  PlayerBridgeSetup,
  PlayerBridgeStatus,
  PlayerDetails,
  PlayerList,
  ServerUsage,
  ServerSoftware,
} from './types';

const API_ROOT = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

function endpoint(path: string): string {
  return `${API_ROOT}${path.startsWith('/') ? path : `/${path}`}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint(path), {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const contentType = response.headers.get('content-type') ?? '';
  const body: unknown = contentType.includes('application/json')
    ? await response.json().catch(() => undefined)
    : await response.text().catch(() => undefined);

  if (!response.ok) {
    const detail = body as { message?: string; error?: string } | undefined;
    throw new ApiError(detail?.message ?? detail?.error ?? `Request failed (${response.status})`, response.status, body);
  }

  return body as T;
}

function unwrap<T>(payload: T | { data: T }): T {
  return payload && typeof payload === 'object' && 'data' in payload
    ? (payload as { data: T }).data
    : (payload as T);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeServer(value: unknown): Server {
  const raw = object(value);
  const rawStatus = typeof raw.status === 'string' ? raw.status.toLowerCase() : 'unknown';
  const status = rawStatus === 'offline' ? 'stopped' : rawStatus;
  return {
    id: String(raw.id ?? ''),
    machineId: typeof raw.machineId === 'string' ? raw.machineId : undefined,
    name: String(raw.name ?? 'Unnamed server'),
    game: typeof raw.game === 'string' ? raw.game : 'minecraft',
    distribution: typeof raw.distribution === 'string' ? raw.distribution : typeof raw.flavor === 'string' ? raw.flavor : undefined,
    software: typeof raw.software === 'string' ? raw.software : undefined,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    loaderVersion: typeof raw.loaderVersion === 'string' ? raw.loaderVersion : undefined,
    startupConfig: typeof raw.startupConfig === 'object' && raw.startupConfig !== null
      ? raw.startupConfig as Server['startupConfig']
      : undefined,
    status: ['running', 'stopped', 'installing', 'starting', 'stopping', 'error'].includes(status)
      ? (status as Server['status'])
      : 'unknown',
    port: number(raw.port),
    directory: typeof raw.directory === 'string' ? raw.directory : typeof raw.path === 'string' ? raw.path : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    pid: number(raw.pid),
    memory: object(raw.memory),
    memoryMb: number(raw.memoryMb),
    requiredJavaMajor: number(raw.requiredJavaMajor),
    installState: typeof raw.installState === 'string' ? raw.installState : undefined,
    javaPath: typeof raw.javaPath === 'string' ? raw.javaPath : undefined,
    lastStartedAt: typeof raw.lastStartedAt === 'string' ? raw.lastStartedAt : undefined,
    lastStoppedAt: typeof raw.lastStoppedAt === 'string' ? raw.lastStoppedAt : undefined,
    players: object(raw.players) as Server['players'],
    error: typeof raw.error === 'string' ? raw.error : typeof raw.lastError === 'string' ? raw.lastError : undefined,
  };
}

function serverList(value: unknown): Server[] {
  const payload = unwrap(value as never) as unknown;
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(object(payload).servers)
      ? (object(payload).servers as unknown[])
      : [];
  return raw.map(normalizeServer).filter((server) => Boolean(server.id));
}

function normalizeSystem(value: unknown): SystemMetrics {
  const raw = object(unwrap(value as never));
  const cpu = object(raw.cpu);
  const memory = object(raw.memory);
  const disk = object(raw.disk);
  return {
    cpu: {
      usagePercent: number(cpu.usagePercent ?? raw.cpuUsage ?? raw.cpuPercent),
      cores: number(cpu.cores ?? raw.cpuCores),
      model: typeof cpu.model === 'string' ? cpu.model : undefined,
    },
    memory: {
      usedBytes: number(memory.usedBytes ?? raw.memoryUsedBytes),
      totalBytes: number(memory.totalBytes ?? raw.memoryTotalBytes),
      usagePercent: number(memory.usagePercent ?? raw.memoryUsagePercent),
    },
    disk: {
      usedBytes: number(disk.usedBytes ?? raw.diskUsedBytes),
      totalBytes: number(disk.totalBytes ?? raw.diskTotalBytes),
      usagePercent: number(disk.usagePercent ?? raw.diskUsagePercent),
      path: typeof disk.path === 'string' ? disk.path : undefined,
    },
    platform: typeof raw.platform === 'string' ? raw.platform : undefined,
    hostname: typeof raw.hostname === 'string' ? raw.hostname : undefined,
    uptimeSeconds: number(raw.uptimeSeconds ?? raw.uptime),
    activeServers: number(raw.activeServers),
  };
}

export const api = {
  async dashboard(): Promise<DashboardData> {
    try {
      return unwrap(await request<DashboardData | { data: DashboardData }>('/dashboard'));
    } catch (error) {
      // Older backend versions may expose the two resources independently.
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      const [servers, system] = await Promise.all([api.servers(), api.system()]);
      return { servers, system };
    }
  },

  async servers(): Promise<Server[]> {
    return serverList(await request<unknown>('/servers'));
  },

  async server(id: string): Promise<Server> {
    const payload = unwrap(await request<unknown>(`/servers/${encodeURIComponent(id)}`));
    return normalizeServer(object(payload).server ?? payload);
  },

  async system(): Promise<SystemMetrics> {
    return normalizeSystem(await request<unknown>('/system'));
  },

  async minecraftVersions(software: ServerSoftware | string): Promise<MinecraftVersion[]> {
    const query = new URLSearchParams({ software });
    const payload = unwrap(await request<unknown>(`/minecraft/versions?${query}`));
    const values = Array.isArray(payload)
      ? payload
      : Array.isArray(object(payload).versions)
        ? (object(payload).versions as unknown[])
        : [];
    return values.map((item) => {
      const version = object(item);
      return {
        id: String(version.id ?? version.version ?? ''),
        label: typeof version.label === 'string' ? version.label : undefined,
        releaseDate: typeof version.releaseDate === 'string'
          ? version.releaseDate
          : typeof version.releaseTime === 'string'
            ? version.releaseTime
            : undefined,
        stable: typeof version.stable === 'boolean' ? version.stable : undefined,
        javaMajor: number(version.javaMajor),
      };
    }).filter((version) => Boolean(version.id));
  },

  async java(): Promise<JavaDiscovery> {
    const payload = unwrap(await request<unknown>('/java'));
    const raw = object(payload);
    const installations = Array.isArray(payload)
      ? payload
      : Array.isArray(raw.installations)
        ? raw.installations
        : Array.isArray(raw.java)
          ? raw.java
          : [];
    return {
      installations: installations.map((item) => {
        const java = object(item);
        return {
          path: String(java.path ?? java.executable ?? ''),
          version: String(java.version ?? 'Unknown'),
          major: number(java.major ?? java.majorVersion),
          vendor: typeof java.vendor === 'string' ? java.vendor : undefined,
          compatible: typeof java.compatible === 'boolean' ? java.compatible : undefined,
        };
      }).filter((installation) => Boolean(installation.path)),
      message: typeof raw.message === 'string' ? raw.message : undefined,
    };
  },

  async minecraftRequirements(software: ServerSoftware | string, version: string): Promise<MinecraftRequirements> {
    const query = new URLSearchParams({ software, version });
    const payload = unwrap(await request<unknown>(`/minecraft/requirements?${query}`));
    const raw = object(payload);
    const values = Array.isArray(raw.compatibleJava) ? raw.compatibleJava : [];
    return {
      requiredJavaMajor: number(raw.requiredJavaMajor),
      compatibleJava: values.map((item) => {
        const java = object(item);
        return {
          path: String(java.path ?? java.executable ?? ''),
          version: String(java.version ?? 'Unknown'),
          major: number(java.major ?? java.majorVersion),
          vendor: typeof java.vendor === 'string' ? java.vendor : undefined,
          compatible: true,
        };
      }).filter((installation) => Boolean(installation.path)),
      message: typeof raw.message === 'string' ? raw.message : undefined,
    };
  },

  async createServer(input: CreateServerInput): Promise<Server> {
    const payload = unwrap(
      await request<unknown>('/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: input.name,
          software: input.software,
          version: input.version,
          port: input.port,
          memoryMb: input.memoryMb,
          eulaAccepted: input.eulaAccepted,
        }),
      }),
    );
    return normalizeServer(object(payload).server ?? payload);
  },

  async inspectImportDirectory(path: string): Promise<ImportInspection> {
    const payload = unwrap(await request<unknown>('/imports/inspect-directory', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }));
    return (object(payload).inspection ?? payload) as ImportInspection;
  },

  async uploadImportArchive(file: File): Promise<{ uploadId: string; inspection: ImportInspection }> {
    const form = new FormData();
    form.set('file', file, file.name);
    const payload = unwrap(await request<unknown>('/imports/upload-archive', { method: 'POST', body: form }));
    const raw = object(payload);
    return { uploadId: String(raw.uploadId ?? ''), inspection: raw.inspection as ImportInspection };
  },

  async importServer(input: ImportServerInput): Promise<{ server: Server; inspection: ImportInspection; warnings: string[] }> {
    const payload = unwrap(await request<unknown>('/imports', { method: 'POST', body: JSON.stringify(input) }));
    const raw = object(payload);
    return {
      server: normalizeServer(raw.server ?? raw),
      inspection: (raw.inspection ?? {}) as ImportInspection,
      warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((item): item is string => typeof item === 'string') : [],
    };
  },

  async updateServer(id: string, input: UpdateServerInput): Promise<Server> {
    const payload = unwrap(
      await request<unknown>(`/servers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    );
    return normalizeServer(object(payload).server ?? payload);
  },

  async lifecycle(id: string, action: 'start' | 'stop' | 'restart'): Promise<Server> {
    const payload = unwrap(
      await request<unknown>(`/servers/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
    );
    return normalizeServer(object(payload).server ?? payload);
  },

  async deleteServer(id: string): Promise<void> {
    await request<unknown>(`/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async sendCommand(id: string, command: string): Promise<void> {
    await request<unknown>(`/servers/${encodeURIComponent(id)}/command`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  },

  async logs(id: string, tail = 400): Promise<ConsoleLine[]> {
    const query = new URLSearchParams({ tail: String(tail) });
    const payload = unwrap(await request<unknown>(`/servers/${encodeURIComponent(id)}/logs?${query}`));
    const raw = object(payload);
    const values = Array.isArray(payload) ? payload : Array.isArray(raw.logs) ? raw.logs : [];
    return values.map((line) => {
      if (typeof line === 'string') return { message: line };
      const rawLine = object(line);
      return {
        timestamp: typeof rawLine.timestamp === 'string' ? rawLine.timestamp : undefined,
        stream: typeof rawLine.stream === 'string' ? rawLine.stream : undefined,
        message: typeof rawLine.message === 'string' ? rawLine.message : JSON.stringify(rawLine),
      };
    });
  },

  async usage(id: string): Promise<ServerUsage> {
    const payload = unwrap(await request<unknown>(`/servers/${encodeURIComponent(id)}/usage`));
    const raw = object(payload);
    const current = raw.current && typeof raw.current === 'object' ? raw.current as ServerUsage['current'] : undefined;
    const history = Array.isArray(raw.history) ? raw.history as ServerUsage['history'] : [];
    const rawStatus = typeof raw.status === 'string' ? raw.status.toLowerCase() : 'unknown';
    return {
      serverId: String(raw.serverId ?? id),
      status: rawStatus === 'offline' ? 'stopped' : rawStatus as ServerUsage['status'],
      current,
      history,
      capabilities: raw.capabilities && typeof raw.capabilities === 'object'
        ? raw.capabilities as ServerUsage['capabilities']
        : undefined,
    };
  },

  async properties(id: string): Promise<ServerProperties> {
    const payload = unwrap(await request<unknown>(`/servers/${encodeURIComponent(id)}/properties`));
    const properties = object(payload).values ?? object(payload).properties ?? payload;
    return Object.fromEntries(
      Object.entries(object(properties)).map(([key, value]) => [key, String(value)]),
    );
  },

  async saveProperties(id: string, properties: ServerProperties): Promise<ServerProperties> {
    const payload = unwrap(
      await request<unknown>(`/servers/${encodeURIComponent(id)}/properties`, {
        method: 'PUT',
        body: JSON.stringify({ values: properties }),
      }),
    );
    const saved = object(payload).values ?? object(payload).properties ?? payload;
    return Object.fromEntries(Object.entries(object(saved)).map(([key, value]) => [key, String(value)]));
  },

  async files(id: string, path = ''): Promise<FileEntry[]> {
    const query = new URLSearchParams();
    if (path) query.set('path', path);
    const suffix = query.size ? `?${query}` : '';
    const payload = unwrap(await request<unknown>(`/servers/${encodeURIComponent(id)}/files${suffix}`));
    const values = Array.isArray(payload)
      ? payload
      : Array.isArray(object(payload).files)
        ? (object(payload).files as unknown[])
        : [];
    return values.map((item) => {
      const file = object(item);
      return {
        name: String(file.name ?? ''),
        path: String(file.path ?? file.name ?? ''),
        type: file.type === 'directory' || file.isDirectory === true ? 'directory' : 'file',
        size: number(file.size),
        modifiedAt: typeof file.modifiedAt === 'string' ? file.modifiedAt : undefined,
      };
    });
  },

  async fileContent(id: string, path: string): Promise<FileContent> {
    const query = new URLSearchParams({ path });
    const payload = unwrap(
      await request<unknown>(
        `/servers/${encodeURIComponent(id)}/files/content?${query}`,
      ),
    );
    const file = object(payload).file ?? payload;
    const raw = object(file);
    return {
      path: String(raw.path ?? path),
      content: String(raw.content ?? ''),
      encoding: typeof raw.encoding === 'string' ? raw.encoding : undefined,
    };
  },

  async saveFile(id: string, path: string, content: string): Promise<void> {
    await request<unknown>(`/servers/${encodeURIComponent(id)}/files/content`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    });
  },

  async renameFile(id: string, path: string, newName: string): Promise<{ path: string }> {
    const payload = unwrap(
      await request<unknown>(`/servers/${encodeURIComponent(id)}/files/rename`, {
        method: 'POST',
        body: JSON.stringify({ path, newName }),
      }),
    );
    const raw = object(payload).file ?? payload;
    return { path: String(object(raw).path ?? '') };
  },

  async deleteFile(id: string, path: string): Promise<void> {
    const query = new URLSearchParams({ path });
    await request<unknown>(`/servers/${encodeURIComponent(id)}/files?${query}`, {
      method: 'DELETE',
    });
  },

  async copyFile(id: string, sourcePath: string, destinationDir: string): Promise<{ path: string }> {
    const payload = unwrap(
      await request<unknown>(`/servers/${encodeURIComponent(id)}/files/copy`, {
        method: 'POST',
        body: JSON.stringify({ sourcePath, destinationDir }),
      }),
    );
    const raw = object(payload).file ?? payload;
    return { path: String(object(raw).path ?? '') };
  },

  async moveFile(id: string, sourcePath: string, destinationDir: string): Promise<{ path: string }> {
    const payload = unwrap(
      await request<unknown>(`/servers/${encodeURIComponent(id)}/files/move`, {
        method: 'POST',
        body: JSON.stringify({ sourcePath, destinationDir }),
      }),
    );
    const raw = object(payload).file ?? payload;
    return { path: String(object(raw).path ?? '') };
  },

  async createFile(id: string, parentPath: string, name: string, content = ''): Promise<{ path: string }> {
    const payload = unwrap(
      await request<unknown>(`/servers/${encodeURIComponent(id)}/files/create-file`, {
        method: 'POST',
        body: JSON.stringify({ parentPath, name, content }),
      }),
    );
    const raw = object(payload).file ?? payload;
    return { path: String(object(raw).path ?? '') };
  },

  async createFolder(id: string, parentPath: string, name: string): Promise<{ path: string }> {
    const payload = unwrap(
      await request<unknown>(`/servers/${encodeURIComponent(id)}/files/create-folder`, {
        method: 'POST',
        body: JSON.stringify({ parentPath, name }),
      }),
    );
    const raw = object(payload).folder ?? payload;
    return { path: String(object(raw).path ?? '') };
  },

  async addons(id: string): Promise<AddonList> {
    const payload = unwrap(await request<unknown>(`/servers/${encodeURIComponent(id)}/addons`));
    return payload as AddonList;
  },

  async searchAddons(id: string, type: AddonType, source: 'modrinth' | 'hangar', query: string): Promise<AddonCatalogResult[]> {
    const parameters = new URLSearchParams({ type, source, query });
    const payload = unwrap(await request<unknown>(`/servers/${encodeURIComponent(id)}/addons/search?${parameters}`));
    const results = object(payload).results;
    return Array.isArray(results) ? results as AddonCatalogResult[] : [];
  },

  async addonUpdates(id: string): Promise<AddonUpdate[]> {
    const payload = unwrap(await request<unknown>(`/servers/${encodeURIComponent(id)}/addons/updates`));
    const updates = object(payload).updates;
    return Array.isArray(updates) ? updates as AddonUpdate[] : [];
  },

  async installModrinthAddon(id: string, type: AddonType, projectId: string, allowMissingDependencies = false): Promise<void> {
    await request<unknown>(`/servers/${encodeURIComponent(id)}/addons/modrinth`, {
      method: 'POST',
      body: JSON.stringify({ type, projectId, allowMissingDependencies }),
    });
  },

  async installHangarAddon(id: string, projectId: string): Promise<void> {
    await request<unknown>(`/servers/${encodeURIComponent(id)}/addons/hangar`, {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    });
  },

  async uploadAddon(id: string, type: AddonType, file: File): Promise<void> {
    const form = new FormData();
    form.set('file', file, file.name);
    const query = new URLSearchParams({ type });
    await request<unknown>(`/servers/${encodeURIComponent(id)}/addons/upload?${query}`, { method: 'POST', body: form });
  },

  async updateAddon(id: string, type: AddonType, fileName: string): Promise<void> {
    await request<unknown>(`/servers/${encodeURIComponent(id)}/addons/update`, {
      method: 'POST',
      body: JSON.stringify({ type, fileName }),
    });
  },

  async removeAddon(id: string, type: AddonType, fileName: string): Promise<void> {
    await request<unknown>(`/servers/${encodeURIComponent(id)}/addons/${type}/${encodeURIComponent(fileName)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true }),
    });
  },

  async players(id: string): Promise<PlayerList> {
    return unwrap(await request<PlayerList | { data: PlayerList }>(`/servers/${encodeURIComponent(id)}/players`));
  },

  async player(id: string, reference: string): Promise<PlayerDetails> {
    const payload = unwrap(await request<unknown>(`/servers/${encodeURIComponent(id)}/players/${encodeURIComponent(reference)}`));
    return (object(payload).player ?? payload) as PlayerDetails;
  },

  async playerAction(id: string, player: ManagedPlayer | PlayerDetails, action: PlayerAction, input: PlayerActionInput = {}): Promise<{ mode: 'bridge' | 'command'; message: string }> {
    const reference = player.uuid ?? player.name;
    return unwrap(await request<{ mode: 'bridge' | 'command'; message: string } | { data: { mode: 'bridge' | 'command'; message: string } }>(`/servers/${encodeURIComponent(id)}/players/action`, {
      method: 'POST',
      body: JSON.stringify({ player: reference, action, ...input }),
    }));
  },

  async playerBridge(id: string): Promise<PlayerBridgeStatus> {
    const payload = unwrap(await request<unknown>(`/servers/${encodeURIComponent(id)}/players/bridge`));
    return (object(payload).bridge ?? payload) as PlayerBridgeStatus;
  },

  async createPlayerBridgeCredentials(id: string): Promise<PlayerBridgeSetup> {
    return unwrap(await request<PlayerBridgeSetup | { data: PlayerBridgeSetup }>(`/servers/${encodeURIComponent(id)}/players/bridge/credentials`, { method: 'POST' }));
  },
};

export function websocketUrl(serverId: string): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) {
    const url = new URL(explicit, window.location.href);
    url.searchParams.set('serverId', serverId);
    return url.toString();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${API_ROOT}/servers/${encodeURIComponent(serverId)}/console`;
}
