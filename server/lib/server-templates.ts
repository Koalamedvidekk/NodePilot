import { z } from 'zod';

import { AppError } from './errors.js';
import type { MinecraftVersion, ProvisionableServerSoftware, ServerSoftware } from '../types.js';

export const templateSettingsSchema = z.object({
  gameMode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
  difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']),
  hardcore: z.boolean(),
  whitelist: z.boolean(),
  maxPlayers: z.number().int().min(1).max(1_000),
  viewDistance: z.number().int().min(3).max(32),
  structures: z.boolean(),
  seed: z.string().max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Seed cannot contain control characters.'),
}).strict();

export type ServerTemplateSettings = z.infer<typeof templateSettingsSchema>;
export interface ServerTemplate {
  id: string;
  name: string;
  description: string;
  defaultSoftware: ProvisionableServerSoftware;
  software: ProvisionableServerSoftware[];
  minimumVersion: string;
  defaults: ServerTemplateSettings;
}
export interface ResolvedServerTemplate {
  id: string;
  name: string;
  settings: ServerTemplateSettings;
  properties: Record<string, string>;
}

const defaults: ServerTemplateSettings = { gameMode: 'survival', difficulty: 'normal', hardcore: false,
  whitelist: false, maxPlayers: 20, viewDistance: 10, structures: true, seed: '' };

const templates: ServerTemplate[] = [
  { id: 'smp', name: 'SMP', description: 'Survival multiplayer on Paper, ready for friends and optional plugins.',
    defaultSoftware: 'paper', software: ['paper', 'purpur'], minimumVersion: '1.8', defaults: { ...defaults } },
  { id: 'pure-vanilla', name: 'Pure Vanilla', description: 'The official Mojang server with classic survival settings. No plugins or mods.',
    defaultSoftware: 'vanilla', software: ['vanilla'], minimumVersion: '1.8', defaults: { ...defaults, difficulty: 'easy' } },
  { id: 'creative', name: 'Creative', description: 'A peaceful building world with Creative mode and structures enabled.',
    defaultSoftware: 'vanilla', software: ['vanilla', 'paper', 'purpur'], minimumVersion: '1.8',
    defaults: { ...defaults, gameMode: 'creative', difficulty: 'peaceful' } },
  { id: 'hardcore', name: 'Hardcore', description: 'One-life survival locked to Hard difficulty. Death has permanent consequences.',
    defaultSoftware: 'vanilla', software: ['vanilla', 'paper', 'purpur'], minimumVersion: '1.8',
    defaults: { ...defaults, hardcore: true, difficulty: 'hard' } },
];

/** Return independent copies so a caller cannot modify another user's preset. */
export function listServerTemplates(): ServerTemplate[] { return structuredClone(templates); }

export function requireServerTemplate(id: string, software?: ServerSoftware): ServerTemplate {
  const template = templates.find(item => item.id === id);
  if (!template) throw new AppError(400, 'unknown_server_template', 'Choose an available server template.');
  if (software && !template.software.includes(software as ProvisionableServerSoftware)) {
    throw new AppError(422, 'template_software_incompatible', `${template.name} is available for ${template.software.join(', ')}. Choose compatible software or Custom setup.`);
  }
  return structuredClone(template);
}

export function templateSupportsVersion(template: ServerTemplate, version: string): boolean {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) return false;
  const current = version.split('.').map(Number);
  const minimum = template.minimumVersion.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (current[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function filterTemplateVersions(template: ServerTemplate, versions: MinecraftVersion[]): MinecraftVersion[] {
  return versions.filter(version => version.available && version.type === 'release' && templateSupportsVersion(template, version.id));
}

export function resolveServerTemplate(id: string | undefined, software: ServerSoftware, version: string,
  overrides?: Partial<ServerTemplateSettings>): ResolvedServerTemplate | undefined {
  if (!id) {
    if (overrides !== undefined) throw new AppError(400, 'template_required', 'Choose a template before supplying template settings.');
    return undefined;
  }
  const template = requireServerTemplate(id, software);
  if (!templateSupportsVersion(template, version)) {
    throw new AppError(422, 'template_version_incompatible', `${template.name} requires a stable Minecraft Java release from ${template.minimumVersion} onward.`);
  }
  const changes = overrides === undefined ? {} : templateSettingsSchema.partial().parse(overrides);
  const settings = templateSettingsSchema.parse({ ...template.defaults, ...changes });
  if (settings.hardcore && (settings.gameMode !== 'survival' || settings.difficulty !== 'hard')) {
    throw new AppError(400, 'invalid_hardcore_settings', 'Hardcore requires Survival mode and Hard difficulty.');
  }
  const legacy = Number(version.split('.')[0]) === 1 && Number(version.split('.')[1]) < 14;
  // Mojang introduced named values in 1.14; earlier releases need integer IDs.
  const gameMode = legacy ? String(['survival', 'creative', 'adventure', 'spectator'].indexOf(settings.gameMode)) : settings.gameMode;
  const difficulty = legacy ? String(['peaceful', 'easy', 'normal', 'hard'].indexOf(settings.difficulty)) : settings.difficulty;
  return { id: template.id, name: template.name, settings, properties: {
    gamemode: gameMode, difficulty, hardcore: String(settings.hardcore), 'white-list': String(settings.whitelist),
    'max-players': String(settings.maxPlayers), 'view-distance': String(settings.viewDistance),
    'generate-structures': String(settings.structures), 'level-seed': settings.seed,
  } };
}
