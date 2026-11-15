import { request } from "./api";

export interface BrowserAccount {
  id: string;
  name: string;
  uuid: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface BrowserAccessStatus {
  serverId: string;
  configured: boolean;
  enabled: boolean;
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
  accounts: (serverId: string) =>
    request<{ accounts: BrowserAccount[] }>(`${base(serverId)}/accounts`),
  createAccount: (serverId: string, name: string, password: string) =>
    post<{ account: BrowserAccount }>(`${base(serverId)}/accounts`, {
      name,
      password,
    }),
  resetPassword: (serverId: string, accountId: string, password: string) =>
    post<{ account: BrowserAccount }>(
      `${base(serverId)}/accounts/${encodeURIComponent(accountId)}/password`,
      { password },
    ),
  revokeAccount: (serverId: string, accountId: string) =>
    request<{ ok: true }>(
      `${base(serverId)}/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE" },
    ),
};
