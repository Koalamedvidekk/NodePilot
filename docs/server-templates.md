# Server templates

Open **Servers → Create server**, choose **Java Edition**, then select a template:

| Template | Software | Starting settings |
| --- | --- | --- |
| SMP | Paper or Purpur | Survival, Normal difficulty, EssentialsX and LuckPerms |
| Optimized SMP | Fabric or NeoForge | Survival with Lithium and FerriteCore performance mods |
| Pure Vanilla | Official Mojang Vanilla | Survival, Easy difficulty, 20 players |
| Creative | Vanilla, Paper or Purpur | Creative, Peaceful difficulty, 20 players |
| Hardcore | Vanilla, Paper or Purpur | Survival, Hard difficulty, one life |
| Custom setup | Any existing supported software | NodePilot's usual creation defaults |

Pick the Minecraft version in the same step. Versions come from the selected
software's trusted upstream catalogue. The initial bundle chooses the newest
stable version compatible with all selected add-ons and their dependencies. A
version you select explicitly is preserved: if an add-on cannot support it, the
Configure step explains the problem and offers compatible releases. Remove
add-ons to regain the template's ordinary version choices. Optimized SMP starts
at 1.16.5 where publisher/loader support exists; the other presets start at 1.8.
Older releases still require a compatible Java runtime.

In **Configure**, adjust the default game mode, difficulty, player limit, view
distance, world seed, structures, whitelist and Hardcore setting. **Reset template
settings** restores that preset's defaults. Hardcore requires Survival and Hard
difficulty. An empty seed means random; numeric seeds retain their full precision.

The **Included plugins/mods** section lets you remove recommendations or search
Modrinth and, for plugins, Hangar. Required dependencies are included automatically.
The preview shows exact files and versions, dependency relationships, and initial
configuration changes. It expires after 15 minutes and refreshes while the wizard
remains open. Client-only or client-required mods are refused by these server-only
presets; players do not need a matching client modpack.

Review the settings and files, explicitly accept Minecraft's EULA, then create.
Bundle installation runs in the background. Its server page shows real download
progress, the current phase, Cancel, errors and Retry. Minecraft remains stopped
until the complete bundle succeeds. Retries reuse verified downloads and keep
the selected versions. Other file/settings changes and startup stay blocked while
installation is incomplete. A short commit cannot be cancelled midway.

Start normally to generate the world. If you enabled the whitelist, allow players
through Console with `whitelist add PlayerName`.

Templates apply settings once during creation. SMP initially allows ordinary
players to use `/home`, `/sethome`, `/delhome`, `/msg`, `/reply`, `/tpa`, `/tpaccept`
and `/tpdeny` through a namespaced permission definition in `permissions.yml`.
It grants no operator, rank-management or administrative powers. Initial bStats
metrics are disabled for the curated plugins. Owner permissions remain managed
through LuckPerms and the existing panel controls.

Pure Vanilla always remains free of plugins and mods. Creative and Hardcore keep
their existing gameplay defaults and offer optional plugins on Paper/Purpur.
Gameplay modpacks/client-pack exports and curated Forge/Quilt bundles are outside
this release; their existing manual management remains available.

Existing servers and later edits are preserved on restart. Installed bundle files
appear in **Plugins** or **Mods**, with the normal tracked update/removal and
pending-change workflows. Edit gameplay settings through **Properties** and
**Worlds**. Use **Versions** to change an existing Minecraft version with a backup.
Bedrock retains its existing creation flow.

The presets leave Java account authentication enabled and remote console disabled.
They do not automatically change the memory limit; choose that in Configure.

API clients can read `GET /api/minecraft/templates`, search through
`GET /api/minecraft/templates/addons/search`, and submit software, Minecraft
version, settings and catalogue selections to `POST /api/minecraft/templates/preview`.
Send its opaque `planId` as `templatePlanId`, together with matching `templateId`
and `templateSettings`, to `POST /api/servers`. Bundles return HTTP 202 with an
installing server and operation status; requests without a bundle retain the
ordinary creation response. Reusing a consumed plan returns the same server.

Poll `GET /api/servers/:id/template-installation` and use its `/retry` or `/cancel`
POST endpoints as needed. These routes inherit panel authentication. Expired or
changed previews, incompatible add-ons, conflicts and unsafe downloads are refused.

The configuration fields follow [Paper's server.properties reference](https://docs.papermc.io/paper/reference/server-properties/).
For pre-1.14 releases, NodePilot writes the numeric difficulty and game-mode values
described in [Mojang's 1.14 release notes](https://feedback.minecraft.net/hc/en-us/articles/360027306551-Minecraft-Village-Pillage-1-14-0-Java).
