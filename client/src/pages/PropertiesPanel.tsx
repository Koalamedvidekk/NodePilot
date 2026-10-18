import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { CustomSelect, type CustomSelectOption } from '../components/CustomSelect';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { Icon } from '../components/Icon';
import type { ServerProperties } from '../types';
import { errorMessage } from '../utils';

// Standard known boolean property keys in Minecraft Java and Bedrock
const KNOWN_BOOLEAN_KEYS = new Set([
  'accepts-transfers',
  'allow-cheats',
  'allow-flight',
  'allow-nether',
  'broadcast-console-to-ops',
  'broadcast-rcon-to-ops',
  'content-log-file-enabled',
  'correct-player-movement',
  'debug',
  'enable-command-block',
  'enable-jmx-monitoring',
  'enable-query',
  'enable-rcon',
  'enable-status',
  'enforce-secure-profile',
  'enforce-whitelist',
  'force-gamemode',
  'generate-structures',
  'hardcore',
  'hide-online-players',
  'online-mode',
  'prevent-proxy-connections',
  'pvp',
  'require-resource-pack',
  'spawn-animals',
  'spawn-monsters',
  'spawn-npcs',
  'sync-chunk-writes',
  'texturepack-required',
  'use-native-transport',
  'white-list',
  'whitelist',
]);

// Standard known enum property options
const ENUM_CONFIGS: Record<string, CustomSelectOption[]> = {
  gamemode: [
    { value: 'survival', label: 'Survival', description: 'Standard survival gameplay' },
    { value: 'creative', label: 'Creative', description: 'Unlimited resources and free flight' },
    { value: 'adventure', label: 'Adventure', description: 'Blocks cannot be broken without tools' },
    { value: 'spectator', label: 'Spectator', description: 'Invisible, free-flying observer mode' },
  ],
  difficulty: [
    { value: 'peaceful', label: 'Peaceful', description: 'No monsters spawn, health regenerates' },
    { value: 'easy', label: 'Easy', description: 'Hostile mobs deal low damage' },
    { value: 'normal', label: 'Normal', description: 'Standard Minecraft survival difficulty' },
    { value: 'hard', label: 'Hard', description: 'Hostile mobs deal high damage, starvation kills' },
  ],
  'level-type': [
    { value: 'minecraft:normal', label: 'Normal (Default)', description: 'Standard terrain generation' },
    { value: 'minecraft:flat', label: 'Superflat', description: 'Flat plains world' },
    { value: 'minecraft:large_biomes', label: 'Large Biomes', description: 'Biomes are 4× larger' },
    { value: 'minecraft:amplified', label: 'Amplified', description: 'Dramatic cliffs and mountains' },
    { value: 'minecraft:single_biome_surface', label: 'Single Biome', description: 'Single biome throughout world' },
    { value: 'default', label: 'Default', description: 'Legacy / Bedrock default generation' },
  ],
  'op-permission-level': [
    { value: '1', label: 'Level 1 · Moderator', description: 'Can bypass spawn protection' },
    { value: '2', label: 'Level 2 · Gamemaster', description: 'Can use basic cheats and command blocks' },
    { value: '3', label: 'Level 3 · Administrator', description: 'Can ban, kick, and op other players' },
    { value: '4', label: 'Level 4 · Owner / Co-owner', description: 'Full server administration commands' },
  ],
  'function-permission-level': [
    { value: '1', label: 'Level 1', description: 'Basic function execution' },
    { value: '2', label: 'Level 2', description: 'Command block equivalent' },
    { value: '3', label: 'Level 3', description: 'Admin commands in functions' },
    { value: '4', label: 'Level 4', description: 'Full administrator function access' },
  ],
  'default-player-permission-level': [
    { value: 'visitor', label: 'Visitor', description: 'Can only explore, cannot interact with world' },
    { value: 'member', label: 'Member', description: 'Standard player rights' },
    { value: 'operator', label: 'Operator', description: 'Operator administrative rights' },
  ],
  'server-authoritative-movement': [
    { value: 'client-auth', label: 'Client Authoritative', description: 'Client calculates positions' },
    { value: 'server-auth', label: 'Server Authoritative', description: 'Server validates positions' },
    { value: 'server-auth-with-rewind', label: 'Server Auth with Rewind', description: 'Rewinds invalid positions' },
  ],
};

// Helpful friendly descriptions for standard Minecraft properties
const PROPERTY_DESCRIPTIONS: Record<string, string> = {
  gamemode: 'Default game mode for new players joining the server',
  difficulty: 'World difficulty setting affecting combat and survival',
  'server-port': 'Port for player connections (default: 25565 Java / 19132 Bedrock)',
  'server-portv6': 'IPv6 port for Bedrock player connections (default: 19133)',
  motd: 'Message of the day displayed in the multiplayer server list',
  pvp: 'Enable player-versus-player combat damage',
  'max-players': 'Maximum number of simultaneous players permitted',
  'online-mode': 'Validates player accounts with official authentication servers',
  'white-list': 'Only allow players listed in whitelist.json to join',
  whitelist: 'Only allow players listed in whitelist.json to join',
  'allow-flight': 'Allow players to fly in survival mode without being kicked',
  'view-distance': 'Maximum chunk render distance sent to players (in chunks)',
  'simulation-distance': 'Maximum distance of actively ticked chunks around players',
  'level-name': 'World directory folder name inside the server folder',
  'level-seed': 'World generation seed (leave blank for random)',
  'level-type': 'World generation preset (Normal, Superflat, Amplified, etc.)',
  hardcore: 'Permadeath mode: players are permanently banned upon death',
  'spawn-protection': 'Radius in blocks of protected spawn area around spawn point',
  'enable-command-block': 'Allow command blocks to execute server commands',
  'enforce-secure-profile': 'Require Mojang-signed public chat encryption keys',
  'hide-online-players': 'Do not display player names in server status ping',
  'force-gamemode': 'Force players to rejoin in the server’s default game mode',
  'generate-structures': 'Generate structures (villages, dungeons, temples, etc.)',
  'allow-nether': 'Allow players to travel to the Nether dimension',
  'enable-rcon': 'Enable remote console (RCON) protocol access',
  'rcon.port': 'Port for remote console connections (default: 25575)',
  'rcon.password': 'Password required for remote console authentication',
  'query.port': 'Port for GameSpy4 server queries (default: 25565)',
  'enable-query': 'Enable GameSpy4 query protocol for server pinging',
  'enable-status': 'Show server as online in multiplayer server lists',
  'max-world-size': 'Maximum world radius boundary in blocks',
  'sync-chunk-writes': 'Synchronous file writes when saving chunks to disk',
  'network-compression-threshold': 'Packet compression threshold in bytes (-1 to disable)',
  'rate-limit': 'Max packets before player is kicked for spamming (0 to disable)',
  'player-idle-timeout': 'Minutes before idle players are automatically kicked',
  'spawn-animals': 'Allow friendly animal mobs to spawn in the world',
  'spawn-monsters': 'Allow hostile monster mobs to spawn in the world',
  'spawn-npcs': 'Allow villager NPCs to spawn in villages',
  'accepts-transfers': 'Accept server transfer packets from proxies or other servers',
  'broadcast-console-to-ops': 'Broadcast console command output to online ops',
  'broadcast-rcon-to-ops': 'Broadcast RCON command output to online ops',
  'op-permission-level': 'Default permission level granted when opping a player',
  'function-permission-level': 'Permission level required to execute functions',
  'bug-report-link': 'Custom URL shown to players on crashes or bugs',
  'default-player-permission-level': 'Default permission level for joining Bedrock players',
  'server-authoritative-movement': 'Movement validation mode for Minecraft Bedrock',
};

type FilterCategory = 'all' | 'switches' | 'dropdowns' | 'text' | 'modified';

export function PropertiesPanel({ serverId }: { serverId: string }) {
  const [initialValues, setInitialValues] = useState<ServerProperties>({});
  const [values, setValues] = useState<ServerProperties>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterCategory>('all');
  const [activeDropdownKey, setActiveDropdownKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const data = await api.properties(serverId);
      setInitialValues(data);
      setValues(data);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (key: string, value: string) => {
    setSaved(false);
    setValues((current) => ({ ...current, [key]: value }));
  };

  const remove = (key: string) => {
    setSaved(false);
    setValues((current) =>
      Object.fromEntries(Object.entries(current).filter(([itemKey]) => itemKey !== key))
    );
  };

  const add = () => {
    const key = newKey.trim();
    if (!key) return;
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
      setError('Property names can use letters, numbers, dots, underscores, and hyphens.');
      return;
    }
    if (key in values) {
      setError('That property already exists.');
      return;
    }
    setError(undefined);
    setValues((current) => ({ ...current, [key]: '' }));
    setNewKey('');
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      const response = await api.saveProperties(serverId, values);
      setInitialValues(response);
      setValues(response);
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  // Determine property input type
  const getPropertyType = (key: string, val: string): 'boolean' | 'enum' | 'text' => {
    const lowerKey = key.toLowerCase();
    const lowerVal = val.trim().toLowerCase();
    if (lowerVal === 'true' || lowerVal === 'false') return 'boolean';
    if (KNOWN_BOOLEAN_KEYS.has(lowerKey)) return 'boolean';
    if (ENUM_CONFIGS[lowerKey]) return 'enum';
    return 'text';
  };

  // Check if a property is modified from initial loaded state
  const isPropertyModified = (key: string, val: string): boolean => {
    return initialValues[key] !== undefined && initialValues[key] !== val;
  };

  const dirtyCount = useMemo(() => {
    return Object.entries(values).filter(([k, v]) => initialValues[k] !== undefined && initialValues[k] !== v).length;
  }, [initialValues, values]);

  // All entries sorted alphabetically
  const entries = useMemo(
    () => Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
    [values]
  );

  // Filtered entries according to search query and category tab
  const filteredEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter(([key, val]) => {
      const type = getPropertyType(key, val);
      const isModified = isPropertyModified(key, val);

      // Category filter
      if (filter === 'switches' && type !== 'boolean') return false;
      if (filter === 'dropdowns' && type !== 'enum') return false;
      if (filter === 'text' && type !== 'text') return false;
      if (filter === 'modified' && !isModified) return false;

      // Search query
      if (query) {
        const desc = PROPERTY_DESCRIPTIONS[key.toLowerCase()] ?? '';
        return (
          key.toLowerCase().includes(query) ||
          val.toLowerCase().includes(query) ||
          desc.toLowerCase().includes(query)
        );
      }

      return true;
    });
  }, [entries, search, filter, initialValues]);

  // Counts for filter pills
  const counts = useMemo(() => {
    let switches = 0;
    let dropdowns = 0;
    let text = 0;
    let modified = 0;

    for (const [key, val] of entries) {
      const type = getPropertyType(key, val);
      if (type === 'boolean') switches++;
      else if (type === 'enum') dropdowns++;
      else text++;

      if (isPropertyModified(key, val)) modified++;
    }

    return { all: entries.length, switches, dropdowns, text, modified };
  }, [entries, initialValues]);

  return (
    <section className="management-panel panel properties-panel">
      <div className="panel-heading properties-heading">
        <div>
          <h3>server.properties</h3>
          <p>Configure Minecraft server settings with switches, selection menus, and text options.</p>
        </div>
        <div className="panel-heading-actions">
          {saved && (
            <span className="saved-indicator">
              <Icon name="check" size={16} /> Saved
            </span>
          )}
          {dirtyCount > 0 && !saved && (
            <span className="dirty-indicator">
              <span className="dirty-dot" /> {dirtyCount} unsaved change{dirtyCount === 1 ? '' : 's'}
            </span>
          )}
          <button
            className="button button-secondary button-icon"
            onClick={() => void load()}
            disabled={loading || saving}
            type="button"
          >
            <Icon name="refresh" size={16} /> Reload
          </button>
          <button
            className={`button button-primary ${dirtyCount > 0 ? 'button-pulse' : ''}`}
            type="button"
            onClick={() => void save()}
            disabled={loading || saving}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      {error && (
        <div className="inline-alert alert-error" role="alert">
          <Icon name="warning" size={18} />
          <div>
            <strong>Properties couldn’t be saved.</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="text-button" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Search and Category Filters */}
      <div className="properties-toolbar">
        <div className="properties-search-wrap">
          <Icon name="search" size={16} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search properties (e.g. gamemode, port, pvp, flight)…"
            aria-label="Search server properties"
          />
          {search && (
            <button
              type="button"
              className="properties-search-clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>

        <div className="properties-filter-pills" role="tablist" aria-label="Filter properties by type">
          <button
            type="button"
            className={`properties-filter-pill ${filter === 'all' ? 'is-active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All <span className="pill-count">{counts.all}</span>
          </button>
          <button
            type="button"
            className={`properties-filter-pill ${filter === 'switches' ? 'is-active' : ''}`}
            onClick={() => setFilter('switches')}
          >
            Switches <span className="pill-count">{counts.switches}</span>
          </button>
          <button
            type="button"
            className={`properties-filter-pill ${filter === 'dropdowns' ? 'is-active' : ''}`}
            onClick={() => setFilter('dropdowns')}
          >
            Dropdowns <span className="pill-count">{counts.dropdowns}</span>
          </button>
          <button
            type="button"
            className={`properties-filter-pill ${filter === 'text' ? 'is-active' : ''}`}
            onClick={() => setFilter('text')}
          >
            Text & Ports <span className="pill-count">{counts.text}</span>
          </button>
          {counts.modified > 0 && (
            <button
              type="button"
              className={`properties-filter-pill is-modified-pill ${filter === 'modified' ? 'is-active' : ''}`}
              onClick={() => setFilter('modified')}
            >
              Modified <span className="pill-count">{counts.modified}</span>
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="settings-skeleton">
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : (
        <div className="properties-table">
          <div className="properties-table-head">
            <span>Property & Description</span>
            <span>Value</span>
            <span className="sr-only">Actions</span>
          </div>

          {filteredEntries.map(([key, value]) => {
            const propType = getPropertyType(key, value);
            const description = PROPERTY_DESCRIPTIONS[key.toLowerCase()];
            const isModified = isPropertyModified(key, value);
            const isDropdownOpen = activeDropdownKey === key;

            return (
              <div
                className={`property-row ${isDropdownOpen ? 'has-dropdown-open' : ''} ${isModified ? 'is-modified' : ''}`}
                key={key}
              >
                <div className="property-meta">
                  <div className="property-title-row">
                    <code className="property-key-tag">{key}</code>
                    {isModified && <span className="modified-indicator-dot" title="Modified in this session" />}
                  </div>
                  {description && <small className="property-description">{description}</small>}
                </div>

                <div className="property-value-cell">
                  {/* Boolean Properties -> Animated Switch */}
                  {propType === 'boolean' && (
                    <div className="property-switch-wrap">
                      <ToggleSwitch
                        checked={value.trim().toLowerCase() === 'true'}
                        onChange={(nextChecked) => update(key, nextChecked ? 'true' : 'false')}
                        aria-label={key}
                      />
                      <span
                        className={`property-boolean-badge ${value.trim().toLowerCase() === 'true' ? 'is-true' : 'is-false'}`}
                        onClick={() =>
                          update(key, value.trim().toLowerCase() === 'true' ? 'false' : 'true')
                        }
                      >
                        {value.trim().toLowerCase() === 'true' ? 'true' : 'false'}
                      </span>
                    </div>
                  )}

                  {/* Enum Properties -> CustomSelect Dropdown */}
                  {propType === 'enum' && (
                    <div className="property-select-wrap">
                      {(() => {
                        const baseOptions = ENUM_CONFIGS[key.toLowerCase()] ?? [];
                        // Ensure current value is included even if custom/non-standard
                        const hasCurrent = baseOptions.some(
                          (opt) => opt.value.toLowerCase() === value.trim().toLowerCase()
                        );
                        const options: CustomSelectOption[] = hasCurrent
                          ? baseOptions
                          : value.trim()
                            ? [...baseOptions, { value: value.trim(), label: `${value} (custom)` }]
                            : baseOptions;

                        return (
                          <CustomSelect
                            value={value.trim().toLowerCase()}
                            onChange={(val) => update(key, val)}
                            options={options}
                            aria-label={key}
                            placeholder={`Select ${key}…`}
                            className="property-custom-select"
                            onOpenChange={(isOpen) => setActiveDropdownKey(isOpen ? key : null)}
                          />
                        );
                      })()}
                    </div>
                  )}

                  {/* Text, Ports, Numbers -> Clean Styled Input */}
                  {propType === 'text' && (
                    <div className="property-input-wrap">
                      <input
                        value={value}
                        onChange={(event) => update(key, event.target.value)}
                        aria-label={key}
                        className="property-text-input"
                        placeholder={
                          key.includes('port')
                            ? '25565'
                            : key.includes('players')
                              ? '20'
                              : key.includes('motd')
                                ? 'A Minecraft Server'
                                : 'empty'
                        }
                      />
                    </div>
                  )}
                </div>

                <div className="property-action-cell">
                  <button
                    className="icon-button destructive-soft property-remove-btn"
                    type="button"
                    onClick={() => remove(key)}
                    title={`Remove ${key}`}
                    aria-label={`Remove ${key}`}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              </div>
            );
          })}

          {filteredEntries.length === 0 && (
            <div className="properties-empty">
              <Icon name="search" size={24} />
              <p>
                {search
                  ? `No properties found matching "${search}".`
                  : 'No properties match the selected filter.'}
              </p>
              {search && (
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={() => setSearch('')}
                >
                  Clear search
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add Custom Property */}
      <div className="add-property-card">
        <div className="add-property-header">
          <Icon name="plus" size={16} />
          <strong>Add custom property</strong>
        </div>
        <div className="add-property-form">
          <input
            value={newKey}
            onChange={(event) => setNewKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
            placeholder="e.g. custom-setting or new.property"
            aria-label="New property name"
          />
          <button type="button" className="button button-secondary" onClick={add} disabled={!newKey.trim()}>
            <Icon name="plus" size={16} /> Add property
          </button>
        </div>
      </div>
    </section>
  );
}
