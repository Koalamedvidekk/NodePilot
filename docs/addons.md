# Plugins and mods

Open a server's **Plugins** or **Mods** tab. NodePilot keeps Bukkit/Paper plugins
separate from Fabric, Quilt, Forge, and NeoForge mods and checks the selected
software and Minecraft version before accepting an add-on.

You can install from a catalogue, upload a JAR, update, or remove add-ons while
the server is running. These actions create **Pending changes**. The running
server's JAR files stay in place until its next start or restart; NodePilot does
not reload plugins or mods into a running process.

The pending list shows the scheduled action and replacement filename/version.
Installed files remain listed separately. Use **Cancel change** to undo a queued
action before it is applied. An add-on with a pending action must have that action
cancelled before you schedule a different change to the same file.

Stopping alone does not apply the queue. If changes are already pending, further
edits while stopped join that queue. With no pending queue, edits to a stopped
server are applied to disk immediately as before. All changes take effect when
Minecraft next starts.

Before starting Minecraft, NodePilot validates the pending files and makes backups
of JARs that will be replaced or removed. If safe application fails, startup is
blocked and the tab shows the error. Review or correct the pending changes before
retrying. Pending changes survive restarting NodePilot.

Minecraft version changes wait until pending add-ons have been applied or
cancelled, so files selected for one Minecraft version are not installed on another.

Edits are temporarily unavailable while the server starts, stops, installs, or
performs other maintenance. Add-on configuration and data directories are kept
separate from JAR replacement/removal; individual plugins or mods manage their
own saved data and may still require version-specific migration steps.
