package dev.nodepilot.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.BanList;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.OfflinePlayer;
import org.bukkit.World;
import org.bukkit.attribute.Attribute;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * Optional local-only companion for NodePilot. It maintains an outbound authenticated
 * WebSocket and deliberately exposes a small, fixed set of player operations—never a
 * raw command shell. All Bukkit reads and mutations are scheduled on the Paper main thread.
 */
public final class NodePilotBridgePlugin extends JavaPlugin {
    private static final int MAX_MESSAGE_CHARS = 512 * 1024;
    private final Gson gson = new Gson();
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
    private volatile WebSocket socket;
    private volatile boolean stopping;
    private boolean connecting;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        getLogger().info("NodePilot Bridge enabled. Configure plugins/NodePilotBridge/config.yml from NodePilot's Players tab.");
        scheduleConnect(1L);
    }

    @Override
    public void onDisable() {
        stopping = true;
        WebSocket current = socket;
        socket = null;
        if (current != null) {
            try { current.sendClose(WebSocket.NORMAL_CLOSURE, "Paper server stopping"); } catch (Exception ignored) { }
        }
    }

    private void scheduleConnect(long delayTicks) {
        if (stopping || !isEnabled()) return;
        Bukkit.getScheduler().runTaskLaterAsynchronously(this, this::connect, Math.max(1L, delayTicks));
    }

    private synchronized void connect() {
        if (stopping || connecting || socket != null) return;
        String endpoint = getConfig().getString("nodepilot-url", "").trim();
        String serverId = getConfig().getString("server-id", "").trim();
        String token = getConfig().getString("token", "").trim();
        if (endpoint.isEmpty() || serverId.isEmpty() || token.isEmpty()) {
            getLogger().warning("NodePilot Bridge is not connected: add nodepilot-url, server-id, and token to its config.yml.");
            return;
        }
        try {
            URI uri = URI.create(endpoint);
            if (!isLoopbackUri(uri) || (!"ws".equalsIgnoreCase(uri.getScheme()) && !"wss".equalsIgnoreCase(uri.getScheme()))) {
                getLogger().severe("NodePilot Bridge refuses non-loopback or non-WebSocket endpoints.");
                return;
            }
            UUID.fromString(serverId);
        } catch (Exception error) {
            getLogger().severe("NodePilot Bridge configuration is invalid: " + error.getMessage());
            return;
        }
        connecting = true;
        client.newWebSocketBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .buildAsync(URI.create(endpoint), new BridgeListener(serverId, token))
            .whenComplete((connection, error) -> {
                synchronized (this) { connecting = false; }
                if (error != null && !stopping) {
                    getLogger().warning("NodePilot Bridge connection failed: " + safeError(error));
                    scheduleReconnect();
                }
            });
    }

    private boolean isLoopbackUri(URI uri) {
        String host = uri.getHost();
        return host != null && (host.equals("127.0.0.1") || host.equals("localhost") || host.equals("::1"));
    }

    private void scheduleReconnect() {
        long seconds = Math.max(2L, Math.min(60L, getConfig().getLong("reconnect-seconds", 5L)));
        scheduleConnect(seconds * 20L);
    }

    private String safeError(Throwable error) {
        String message = error.getMessage();
        return message == null ? error.getClass().getSimpleName() : message.replaceAll("[\\r\\n]", " ").substring(0, Math.min(250, message.length()));
    }

    private final class BridgeListener implements WebSocket.Listener {
        private final String serverId;
        private final String token;
        private final StringBuilder input = new StringBuilder();

        private BridgeListener(String serverId, String token) {
            this.serverId = serverId;
            this.token = token;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            socket = webSocket;
            JsonObject hello = new JsonObject();
            hello.addProperty("type", "hello");
            hello.addProperty("serverId", serverId);
            hello.addProperty("token", token);
            hello.addProperty("pluginVersion", getDescription().getVersion());
            JsonArray capabilities = new JsonArray();
            capabilities.add("players.list");
            capabilities.add("players.get");
            capabilities.add("players.action");
            hello.add("capabilities", capabilities);
            send(hello);
            webSocket.request(1);
            getLogger().info("NodePilot Bridge connected locally.");
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            if (input.length() + data.length() > MAX_MESSAGE_CHARS) {
                webSocket.abort();
                return CompletableFuture.completedFuture(null);
            }
            input.append(data);
            if (last) {
                String message = input.toString();
                input.setLength(0);
                handleMessage(message);
            }
            webSocket.request(1);
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            if (socket == webSocket) socket = null;
            if (!stopping) {
                getLogger().warning("NodePilot Bridge disconnected (" + statusCode + "); retrying locally.");
                scheduleReconnect();
            }
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            if (socket == webSocket) socket = null;
            if (!stopping) {
                getLogger().warning("NodePilot Bridge socket error: " + safeError(error));
                scheduleReconnect();
            }
        }
    }

    private void handleMessage(String raw) {
        JsonObject request;
        try {
            JsonElement parsed = JsonParser.parseString(raw);
            if (!parsed.isJsonObject()) return;
            request = parsed.getAsJsonObject();
        } catch (Exception ignored) {
            return;
        }
        if (!"request".equals(string(request, "type"))) return;
        String id = string(request, "id");
        String method = string(request, "method");
        if (id == null || id.length() > 80 || method == null || method.length() > 80) return;
        JsonObject body = request.has("body") && request.get("body").isJsonObject() ? request.getAsJsonObject("body") : new JsonObject();
        Bukkit.getScheduler().runTask(this, () -> {
            try {
                sendResponse(id, true, dispatch(method, body), null);
            } catch (IllegalArgumentException error) {
                sendResponse(id, false, null, error.getMessage());
            } catch (Exception error) {
                getLogger().warning("NodePilot Bridge request failed: " + safeError(error));
                sendResponse(id, false, null, "The server could not complete that player operation.");
            }
        });
    }

    private JsonElement dispatch(String method, JsonObject body) {
        return switch (method) {
            case "players.list" -> listPlayers();
            case "players.get" -> getPlayer(body);
            case "players.action" -> actOnPlayer(body);
            default -> throw new IllegalArgumentException("Unsupported NodePilot bridge operation.");
        };
    }

    private JsonObject listPlayers() {
        JsonObject response = new JsonObject();
        JsonArray players = new JsonArray();
        for (Player player : Bukkit.getOnlinePlayers()) players.add(playerJson(player, true));
        response.add("players", players);
        return response;
    }

    private JsonObject getPlayer(JsonObject body) {
        Player player = findOnline(playerObject(body));
        if (player == null) throw new IllegalArgumentException("That player is not online; live details require an online player.");
        JsonObject response = new JsonObject();
        response.add("player", playerJson(player, true));
        return response;
    }

    private JsonObject actOnPlayer(JsonObject body) {
        String action = string(body, "action");
        if (action == null) throw new IllegalArgumentException("No player action was provided.");
        JsonObject playerRef = playerObject(body);
        Player live = findOnline(playerRef);
        OfflinePlayer offline = findOffline(playerRef, live);
        switch (action) {
            case "op" -> requireOffline(offline).setOp(true);
            case "deop" -> requireOffline(offline).setOp(false);
            case "kick" -> requireOnline(live).kickPlayer(reason(body));
            case "ban" -> ban(requireOffline(offline), reason(body));
            case "unban" -> unban(requireOffline(offline));
            case "heal" -> heal(requireOnline(live));
            case "teleport" -> teleport(requireOnline(live), body);
            case "gamemode" -> gameMode(requireOnline(live), body);
            case "inventory" -> inventory(requireOnline(live), body);
            default -> throw new IllegalArgumentException("Unsupported player action.");
        }
        JsonObject response = new JsonObject();
        response.addProperty("action", action);
        if (live != null && live.isOnline()) response.add("player", playerJson(live, true));
        return response;
    }

    private JsonObject playerObject(JsonObject body) {
        return body.has("player") && body.get("player").isJsonObject() ? body.getAsJsonObject("player") : new JsonObject();
    }

    private OfflinePlayer findOffline(JsonObject ref, Player live) {
        if (live != null) return live;
        UUID uuid = uuid(string(ref, "uuid"));
        if (uuid != null) return Bukkit.getOfflinePlayer(uuid);
        String name = validName(string(ref, "name"));
        return name == null ? null : Bukkit.getOfflinePlayer(name);
    }

    private Player findOnline(JsonObject ref) {
        UUID uuid = uuid(string(ref, "uuid"));
        if (uuid != null) {
            Player player = Bukkit.getPlayer(uuid);
            if (player != null) return player;
        }
        String name = validName(string(ref, "name"));
        return name == null ? null : Bukkit.getPlayerExact(name);
    }

    private OfflinePlayer requireOffline(OfflinePlayer player) {
        if (player == null) throw new IllegalArgumentException("NodePilot could not resolve that player.");
        return player;
    }

    private Player requireOnline(Player player) {
        if (player == null || !player.isOnline()) throw new IllegalArgumentException("This action requires that player to be online.");
        return player;
    }

    private void ban(OfflinePlayer player, String reason) {
        String name = player.getName();
        if (name == null || !validName(name).equals(name)) throw new IllegalArgumentException("This player does not have a valid Minecraft name for a ban operation.");
        Bukkit.getBanList(BanList.Type.NAME).addBan(name, reason, null, "NodePilot");
        if (player.isOnline()) ((Player) player).kickPlayer(reason);
    }

    private void unban(OfflinePlayer player) {
        String name = player.getName();
        if (name == null || !validName(name).equals(name)) throw new IllegalArgumentException("This player does not have a valid Minecraft name for an unban operation.");
        Bukkit.getBanList(BanList.Type.NAME).pardon(name);
    }

    private void heal(Player player) {
        double maximum = 20.0;
        if (player.getAttribute(Attribute.MAX_HEALTH) != null) maximum = player.getAttribute(Attribute.MAX_HEALTH).getValue();
        player.setHealth(Math.max(1.0, maximum));
        player.setFoodLevel(20);
        player.setSaturation(5.0f);
        player.setFireTicks(0);
    }

    private void teleport(Player player, JsonObject body) {
        if (!body.has("teleport") || !body.get("teleport").isJsonObject()) throw new IllegalArgumentException("Teleport coordinates are required.");
        JsonObject destination = body.getAsJsonObject("teleport");
        double x = finite(destination, "x", -29_999_984, 29_999_984);
        double y = finite(destination, "y", -2_032, 2_032);
        double z = finite(destination, "z", -29_999_984, 29_999_984);
        String worldName = string(destination, "world");
        World world = worldName == null || worldName.isBlank() ? player.getWorld() : Bukkit.getWorld(worldName);
        if (world == null) throw new IllegalArgumentException("The requested world is not loaded on this server.");
        if (!player.teleport(new Location(world, x, y, z, player.getLocation().getYaw(), player.getLocation().getPitch()))) {
            throw new IllegalArgumentException("Paper rejected that teleport destination.");
        }
    }

    private void gameMode(Player player, JsonObject body) {
        String mode = string(body, "gamemode");
        try {
            player.setGameMode(GameMode.valueOf(mode == null ? "" : mode.toUpperCase(Locale.ROOT)));
        } catch (Exception error) {
            throw new IllegalArgumentException("The requested game mode is invalid.");
        }
    }

    private void inventory(Player player, JsonObject body) {
        if (!body.has("inventory") || !body.get("inventory").isJsonArray()) throw new IllegalArgumentException("Inventory changes are required.");
        JsonArray changes = body.getAsJsonArray("inventory");
        if (changes.size() == 0 || changes.size() > 64) throw new IllegalArgumentException("Too many inventory changes were requested.");
        PlayerInventory inventory = player.getInventory();
        for (JsonElement element : changes) {
            if (!element.isJsonObject()) throw new IllegalArgumentException("Inventory changes must be objects.");
            JsonObject change = element.getAsJsonObject();
            int slot = integer(change, "slot", 0, 40);
            int count = change.has("count") ? integer(change, "count", 0, 64) : 0;
            String itemId = string(change, "itemId");
            if (count == 0 || itemId == null || itemId.isBlank()) {
                inventory.setItem(slot, null);
                continue;
            }
            if (!itemId.matches("^[a-z0-9_.-]+:[a-z0-9_./-]+$")) throw new IllegalArgumentException("Inventory item IDs must be namespaced Minecraft item IDs.");
            String materialName = itemId.replaceFirst("(?i)^minecraft:", "").toUpperCase(Locale.ROOT);
            Material material = Material.matchMaterial(materialName);
            if (material == null || material.isAir()) throw new IllegalArgumentException("That inventory item is not a recognized Minecraft material.");
            inventory.setItem(slot, new ItemStack(material, count));
        }
        player.updateInventory();
    }

    private JsonObject playerJson(Player player, boolean includeInventory) {
        JsonObject data = new JsonObject();
        data.addProperty("uuid", player.getUniqueId().toString());
        data.addProperty("name", player.getName());
        data.addProperty("online", player.isOnline());
        data.addProperty("op", player.isOp());
        data.addProperty("banned", player.isBanned());
        data.addProperty("health", player.getHealth());
        data.addProperty("hunger", player.getFoodLevel());
        data.addProperty("xpLevel", player.getLevel());
        data.addProperty("xpProgress", player.getExp());
        data.addProperty("gameMode", player.getGameMode().name().toLowerCase(Locale.ROOT));
        Location location = player.getLocation();
        JsonObject locationJson = new JsonObject();
        locationJson.addProperty("world", location.getWorld().getName());
        locationJson.addProperty("x", location.getX());
        locationJson.addProperty("y", location.getY());
        locationJson.addProperty("z", location.getZ());
        locationJson.addProperty("yaw", location.getYaw());
        locationJson.addProperty("pitch", location.getPitch());
        data.add("location", locationJson);
        if (includeInventory) data.add("inventory", inventoryJson(player.getInventory()));
        return data;
    }

    private JsonArray inventoryJson(PlayerInventory inventory) {
        JsonArray result = new JsonArray();
        ItemStack[] contents = inventory.getContents();
        for (int slot = 0; slot < contents.length; slot++) {
            ItemStack item = contents[slot];
            if (item == null || item.getType().isAir() || item.getAmount() <= 0) continue;
            JsonObject entry = new JsonObject();
            entry.addProperty("slot", slot);
            entry.addProperty("itemId", "minecraft:" + item.getType().getKey().getKey());
            entry.addProperty("count", item.getAmount());
            ItemMeta meta = item.getItemMeta();
            if (meta != null && meta.hasDisplayName()) entry.addProperty("displayName", meta.getDisplayName());
            result.add(entry);
        }
        return result;
    }

    private void sendResponse(String id, boolean ok, JsonElement body, String error) {
        JsonObject response = new JsonObject();
        response.addProperty("type", "response");
        response.addProperty("id", id);
        response.addProperty("ok", ok);
        if (ok && body != null) response.add("body", body);
        if (!ok) response.addProperty("error", error == null ? "The bridge request failed." : error.substring(0, Math.min(500, error.length())));
        send(response);
    }

    private void send(JsonObject message) {
        WebSocket current = socket;
        if (current == null) return;
        String encoded = gson.toJson(message);
        if (encoded.length() > MAX_MESSAGE_CHARS) return;
        try { current.sendText(encoded, true); } catch (Exception ignored) { }
    }

    private String string(JsonObject object, String key) {
        if (!object.has(key) || object.get(key).isJsonNull() || !object.get(key).isJsonPrimitive()) return null;
        try {
            String value = object.get(key).getAsString();
            return value.length() <= 512 ? value : null;
        } catch (Exception ignored) { return null; }
    }

    private String reason(JsonObject object) {
        String value = string(object, "reason");
        if (value == null || value.isBlank()) return "Managed by NodePilot";
        String normalized = value.replaceAll("[\\r\\n]", " ").trim();
        if (normalized.length() > 160) throw new IllegalArgumentException("The supplied player reason is too long.");
        return normalized;
    }

    private String validName(String value) {
        return value != null && value.matches("^[A-Za-z0-9_]{3,16}$") ? value : null;
    }

    private UUID uuid(String value) {
        try { return value == null ? null : UUID.fromString(value); } catch (IllegalArgumentException ignored) { return null; }
    }

    private int integer(JsonObject object, String key, int minimum, int maximum) {
        if (!object.has(key) || !object.get(key).isJsonPrimitive()) throw new IllegalArgumentException("Inventory values are invalid.");
        try {
            int value = object.get(key).getAsInt();
            if (value < minimum || value > maximum) throw new IllegalArgumentException("Inventory values are outside the allowed range.");
            return value;
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("Inventory values are invalid.");
        }
    }

    private double finite(JsonObject object, String key, double minimum, double maximum) {
        if (!object.has(key) || !object.get(key).isJsonPrimitive()) throw new IllegalArgumentException("Teleport coordinates are invalid.");
        try {
            double value = object.get(key).getAsDouble();
            if (!Double.isFinite(value) || value < minimum || value > maximum) throw new IllegalArgumentException("Teleport coordinates are outside the world boundary.");
            return value;
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("Teleport coordinates are invalid.");
        }
    }
}
