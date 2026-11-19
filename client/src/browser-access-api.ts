import { request } from "./api";

export interface BrowserAccessStatus {
  serverId: string;
  configured: boolean;
  enabled: boolean;
  needsOpenEnable?: boolean;
  status:
    | "disabled"
    | "preparing"
    | "ready"
    | "starting"
    | "running"
    | "error"
    | "recovery_required";
  phase: string | null;
  progressPercent: number | null;
  publicAddress: string | null;
  localAddress: string | null;
  capabilities: {
    available: boolean;
    reasons: string[];
    targetClients: string[];
    verified: boolean;
    backendVersion?: string;
    backendProtocol?: number | null;
    gatewayUpgradeRequired?: boolean;
    notes?: string[];
  };
  versions: Record<string, string>;
  logs: Array<{ timestamp: string; message: string }>;
  error: string | null;
  preview?: { revision: string; changes: string[]; warnings: string[] };
}

function base(serverId: string): string {
  return `/servers/${encodeURIComponent(serverId)}/browser-access`;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const browserAccessApi = {
  status: (serverId: string) => request<BrowserAccessStatus>(base(serverId)),
  inspect: (serverId: string) =>
    post<BrowserAccessStatus>(`${base(serverId)}/inspect`),
  setup: (serverId: string, revision: string) =>
    post<BrowserAccessStatus>(`${base(serverId)}/setup`, {
      confirm: true,
      revision,
    }),
  enable: (serverId: string) =>
    post<BrowserAccessStatus>(`${base(serverId)}/enable`, { confirm: true }),
  disable: (serverId: string) =>
    post<BrowserAccessStatus>(`${base(serverId)}/disable`, { confirm: true }),
};
