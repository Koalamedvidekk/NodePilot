# Auto-Wake

Open a Java server's **Settings → Auto-Wake**, link the Playit agent, and enable
Auto-Wake. The Playit tunnel must target the **Wake Proxy Port** shown in the
panel. Players use the tunnel's public address in their Minecraft server list.
Keep NodePilot and the Playit agent running on the host computer.

Opening or refreshing the multiplayer list does not wake a sleeping server.
Selecting **Join Server** starts it. If it becomes ready during the brief initial
wait, the player connects directly. Otherwise, Minecraft displays a **Starting
server** notice with the current startup stage. The server continues starting
after this notice appears; joining again does not launch a second copy.

Return to the multiplayer list and select **Refresh** to see updated startup
status. Join again when the server is ready. NodePilot forwards the connection
to Minecraft using its normal login and authentication settings.

When Minecraft reports a percentage, such as spawn-area preparation, NodePilot
shows that actual percentage for the current stage. It is not a percentage of
the entire startup, and NodePilot does not invent a countdown or remaining-time
estimate. Other stages show a description while waiting for Minecraft's output.
The panel's Auto-Wake section also refreshes this information automatically.

The normal Minecraft join screen cannot receive arbitrary live startup text
during its login handshake. The **Starting server** notice is a snapshot; it
does not become a live progress screen or reconnect automatically. This workflow
requires no client mod and does not change the server's authentication settings.

If startup fails, the connection notice explains the failure where available.
The host can inspect NodePilot's **Console** for full details, fix the issue, and
retry. For unavailable Java or installation errors, resolve the dependency or
installation problem before asking players to join again.
