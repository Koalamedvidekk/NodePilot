import { ApiError, getStoredPin, PANEL_AUTH_REQUIRED_EVENT, request } from './api';
import type { WorldDetails, WorldGenerationOptions, WorldList, WorldOperation } from './world-types';

const root = (id: string) => `/servers/${encodeURIComponent(id)}/worlds`;
const world = (id: string, worldId: string) => `${root(id)}/${encodeURIComponent(worldId)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const worldApi = {
  list: (id: string) => request<WorldList>(root(id)),
  details: (id: string, worldId: string) => request<WorldDetails>(world(id, worldId)),
  operation: (id: string, operationId: string) => request<WorldOperation>(`${root(id)}/operations/${encodeURIComponent(operationId)}`),
  prepare: (id: string, input: WorldGenerationOptions & { name: string; revision: string }) => request<{ operation: WorldOperation }>(root(id), json('POST', input)),
  settings: (id: string, worldId: string, input: { revision: string; name: string; difficulty: string; hardcore: boolean }) => request<{ operation: WorldOperation }>(world(id, worldId), json('PATCH', input)),
  rules: (id: string, worldId: string, revision: string, rules: Record<string, boolean | number>) => request<{ operation: WorldOperation }>(`${world(id, worldId)}/gamerules`, json('PUT', { revision, rules })),
  activate: (id: string, worldId: string, revision: string, confirmCompatibility: boolean) => request<{ operation: WorldOperation }>(`${world(id, worldId)}/activate`, json('POST', { revision, confirmCompatibility })),
  remove: (id: string, worldId: string, revision: string, confirmName: string) => request<{ operation: WorldOperation }>(world(id, worldId), json('DELETE', { revision, confirmName })),
  backup: (id: string, worldId: string, revision: string) => request<{ operation: WorldOperation }>(`${world(id, worldId)}/backups`, json('POST', { revision })),
  restore: (id: string, worldId: string, backupId: string, revision: string) => request<{ operation: WorldOperation }>(`${world(id, worldId)}/backups/${encodeURIComponent(backupId)}/restore`, json('POST', { revision, confirm: true })),
  export: (id: string, worldId: string, revision: string) => request<{ operation: WorldOperation }>(`${world(id, worldId)}/export`, json('POST', { revision })),
  inspect: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ operation: WorldOperation }>(`${root(id)}/import/inspect`, { method: 'POST', body: form });
  },
  import: (id: string, input: { inspectionId: string; candidateId: string; name: string; revision: string; confirmCompatibility: boolean }) => request<{ operation: WorldOperation }>(`${root(id)}/import`, json('POST', input)),
  uploadDatapack: (id: string, worldId: string, revision: string, file: File) => {
    const form = new FormData();
    form.append('revision', revision);
    form.append('file', file);
    return request<{ operation: WorldOperation }>(`${world(id, worldId)}/datapacks`, { method: 'POST', body: form });
  },
  selectDatapacks: (id: string, worldId: string, revision: string, enabled: string[], disabled: string[]) => request<{ operation: WorldOperation }>(`${world(id, worldId)}/datapacks`, json('PATCH', { revision, enabled, disabled })),
  removeDatapack: (id: string, worldId: string, packId: string, revision: string) => request<{ operation: WorldOperation }>(`${world(id, worldId)}/datapacks/${encodeURIComponent(packId)}`, json('DELETE', { revision })),
};

export async function downloadWorldExport(serverId: string, downloadUrl: string): Promise<void> {
  const apiRoot = new URL((import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '') + '/', window.location.origin);
  const target = new URL(downloadUrl, apiRoot);
  const requiredPrefix = apiRoot.pathname + `servers/${encodeURIComponent(serverId)}/worlds/operations/`;
  if (target.origin !== apiRoot.origin || !target.pathname.startsWith(requiredPrefix)) throw new Error('The server returned an invalid world download address.');
  const pin = getStoredPin();
  const response = await fetch(target, { headers: pin ? { 'x-nodepilot-pin': pin } : {} });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(PANEL_AUTH_REQUIRED_EVENT));
    const detail = await response.json().catch(() => ({})) as { message?: string };
    throw new ApiError(detail.message ?? 'The world archive could not be downloaded.', response.status);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'nodepilot-world.zip';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
