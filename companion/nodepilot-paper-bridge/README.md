# NodePilot Paper Bridge

This optional Paper plugin gives a local NodePilot installation access to live player state and inventory changes. It is intentionally narrow: it only accepts named player-management operations sent over an authenticated outbound WebSocket. It does not expose a web server or execute arbitrary console commands.

## Install

1. Build `NodePilotBridge-0.1.0.jar` with Maven, or use the included artifact from `dist/` when supplied with a NodePilot release.
2. Upload it on the server's **Add-ons → Plugins** tab, then start the server once so Paper creates `plugins/NodePilotBridge/config.yml`.
3. Stop the server. In NodePilot's **Players** tab, choose **Create credential** and copy the three displayed configuration values into that file.
4. Start the server. The Players tab should report that the bridge is connected.

The token is shown only when it is created. Rotate it from the Players tab if it is lost or exposed.

## Security model

- The plugin initiates a WebSocket connection to `127.0.0.1` by default; it does not open a listener port.
- NodePilot stores only a SHA-256 hash of each bridge token and compares it in constant time.
- The server ID and a 256-bit token are both required before NodePilot accepts the connection.
- Messages are size-limited, the bridge only handles fixed `players.*` operations, and Bukkit mutations run on the Paper main thread.
- NodePilot never passes raw console strings through this bridge.

## Development build

```powershell
mvn package
```

Use a Paper API version compatible with the target server if Maven cannot resolve the default API coordinate. The plugin code intentionally uses stable Bukkit APIs to minimize version coupling.
