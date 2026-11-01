# Worlds

The **Worlds** tab manages saved Minecraft Java worlds on Windows and Linux.
Open a server from the server list, then choose **Worlds**. Bedrock uses a
different format and currently shows an unavailable message.

Stop the game server first. Preparing, selecting, editing, importing, exporting,
backing up, restoring, and deleting worlds all require it to remain stopped.
NodePilot blocks conflicting starts and file maintenance during an operation.
Progress appears in the tab; larger transfers and backups run in the background.

## Your primary world

The primary world is the world selected for the next server start. The saved
world list lets you view other worlds without selecting them for the server.
NodePilot discovers existing worlds without moving them automatically.

The details show the actual saved seed as a decimal string, Minecraft version,
difficulty, hardcore setting, dimensions, size, and save time when available.
**Last saved state** means the server is running and the disk metadata may be
older than its current in-memory state. An unavailable value is not a zero.

An ungenerated world shows **Prepared—not generated yet**. Its requested seed
and preset are separate from actual saved values. Minecraft chooses a random
seed when it generates a world with a blank requested seed.

## Prepare another world

1. Stop the server and choose **Prepare new world**.
2. Enter a display name. Leave the seed blank for random generation or enter a
   numeric or text seed.
3. Choose a supported preset, structures, difficulty, and hardcore setting.
   Hardcore uses Hard difficulty. Advanced generator settings must be a JSON
   object supported by the selected Minecraft preset.
4. Optionally select compatible uploaded datapack ZIPs from the primary world.
   Verified built-in experiments from the installed matching Minecraft runtime
   can also appear as creation choices. Required built-in and software-managed
   packs stay enabled.
5. Choose **Prepare world**. Your current world remains saved. NodePilot selects
   the prepared world and leaves the server stopped.
6. Start the server normally. After generation and a clean stop, refresh Worlds
   to read its saved metadata and edit game rules.

To return to a world, select its row and choose **Use on next start**. Review
version and mod compatibility in the confirmation. NodePilot preserves the
outgoing world and applies the selected world's settings.

World folders keep their own inventories, XP, advancements, statistics, and
player locations, including supported grouped dimensions. A plugin or mod that
stores progress outside world folders still manages that data globally; this
feature does not automatically isolate that software's database or other files.

## Settings, game rules, and datapacks

Display name, difficulty, and hardcore changes need **Save world settings**.
Search the game rules, change switches or integer values, and choose **Save game
rules**. Only recognized rules with a supported saved representation are editable.
Unknown values are preserved and shown read-only. Rules become available after
the world's first generation and stop.

Datapacks are world content packs, separate from server plugins and mods. The
tab groups enabled, disabled, incompatible, and software-managed packs and shows
saved feature flags. Use **Upload datapack ZIP**, then explicitly choose whether
to enable it and **Save datapack selection**. Uploading does not enable a pack.
NodePilot checks its declared format compatibility against the server version.

Required built-in and software-managed packs cannot be removed. Generation,
dimension, and experimental packs are creation-time choices and are locked once
the world has generated. A built-in experiment is offered only when NodePilot
can verify it against the installed matching Minecraft runtime; an unknown
built-in pack stays protected. Online datapack catalogue browsing is not included.

An edit made from an outdated view is rejected. Keep your draft, refresh the saved
world, and review its latest state before retrying.

## ZIP imports and downloads

Choose **Upload world ZIP** to inspect an archive before importing it. Review the
detected world, Minecraft version, seed, dimensions, and warnings. Correct the
display name and confirm compatibility before importing. NodePilot creates a
fresh saved world entry and preserves both existing worlds and the source archive.
It does not overwrite an existing world or select the import automatically.

Ordinary Minecraft world ZIPs and NodePilot grouped-world bundles are supported.
Unsafe archive entries, links, conflicting paths, and excessive expansion are
rejected. A download made with **Download ZIP** includes a manifest so supported
dimension groups and player data can be imported together again. Downloads
require a generated world and a stopped server.

Known newer-world downgrades are blocked. Uncertain compatibility requires an
explicit review; check any required mods or world-generation packs yourself.
Loading an older or uncertain world into the server requires a complete backup.
NodePilot cannot convert a modded world into a vanilla world.

## Backups, deletion, and recovery

**Create world backup** copies the complete supported world group, including
dimensions, player data, and world datapacks. **Restore backup** first backs up
the current files when present, then restores the selected snapshot. The server
stays stopped. Backups are stored in NodePilot's configured shared data directory;
keep a separate copy on another disk for protection against disk failure.

To delete a world, first select a different primary world. Choose **Delete world**
and type its display name exactly. NodePilot makes a complete backup before
removing the files. The deleted entry remains in the library with its retained
backups so you can restore it.

Ordinary settings changes and switches use configuration and metadata snapshots.
Full world backups are used before destructive changes and compatibility upgrades.
NodePilot persists recovery information before changing files. An interrupted
operation is rolled back on restart; if recovery cannot complete, the server
stays blocked from starting and the tab explains that recovery is required.

Ambiguous, corrupt, or unsupported layouts stay read-only with a reason. Do not
rename or move a world's folders through the Files tab while managing it in
Worlds. Preserve the original files and use a complete backup before manual repair.
