# Server templates

Open **Servers → Create server**, choose **Java Edition**, then select a template:

| Template | Software | Starting settings |
| --- | --- | --- |
| SMP | Paper or Purpur | Survival, Normal difficulty, 20 players |
| Pure Vanilla | Official Mojang Vanilla | Survival, Easy difficulty, 20 players |
| Creative | Vanilla, Paper or Purpur | Creative, Peaceful difficulty, 20 players |
| Hardcore | Vanilla, Paper or Purpur | Survival, Hard difficulty, one life |
| Custom setup | Any existing supported software | NodePilot's usual creation defaults |

Pick the Minecraft version in the same step. Versions come from the selected
software's trusted upstream catalogue; templates offer available stable Java
releases from 1.8 onward. A version is retained when switching templates or
software if it is available for the new choice. Older releases still require a
compatible Java runtime.

In **Configure**, adjust the default game mode, difficulty, player limit, view
distance, world seed, structures, whitelist and Hardcore setting. **Reset template
settings** restores that preset's defaults. Hardcore requires Survival and Hard
difficulty. An empty seed means random; numeric seeds retain their full precision.

Review the settings, explicitly accept Minecraft's EULA, then create. The server
remains stopped. Start it normally to generate the world. If you enabled the
whitelist, allow players through Console with `whitelist add PlayerName`.

Templates apply configuration once to the new server's `server.properties`.
They do not install plugins, mods, datapacks or prebuilt worlds, change existing
servers, or replace your settings on restart. Edit settings later through
**Properties** and **Worlds**. Use **Versions** to change an existing server's
Minecraft version with a backup. Bedrock retains its existing creation flow.

The presets leave Java account authentication enabled and remote console disabled.
They do not automatically change the memory limit; choose that in Configure.

API clients can read `GET /api/minecraft/templates`, supply `templateId` to
`GET /api/minecraft/versions?software=...`, and send `templateId` plus optional
`templateSettings` to `POST /api/servers`. These routes inherit panel
authentication. Unknown settings, incompatible software, invalid limits and
invalid Hardcore combinations are rejected before creating files.

The configuration fields follow [Paper's server.properties reference](https://docs.papermc.io/paper/reference/server-properties/).
For pre-1.14 releases, NodePilot writes the numeric difficulty and game-mode values
described in [Mojang's 1.14 release notes](https://feedback.minecraft.net/hc/en-us/articles/360027306551-Minecraft-Village-Pillage-1-14-0-Java).
