package dev.nodepilot.browser;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.inject.Inject;
import com.velocitypowered.api.event.EventTask;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.PreLoginEvent;
import com.velocitypowered.api.event.player.GameProfileRequestEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.plugin.annotation.DataDirectory;
import com.velocitypowered.api.proxy.ProxyServer;
import java.io.Reader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import io.netty.channel.Channel;
import io.netty.channel.ChannelId;
import net.lax1dude.eaglercraft.backend.server.api.velocity.event.EaglercraftLoginEvent;
import net.lax1dude.eaglercraft.backend.server.velocity.VelocityUnsafe;
import org.slf4j.Logger;

public final class BrowserAuth {
    private static final Gson JSON = new Gson();
    private final ProxyServer proxy;
    private final Logger logger;
    private final Path dataDirectory;
    private final Map<ChannelId, NativeApproval> approvedChannels = new ConcurrentHashMap<>();
    private final Semaphore requests = new Semaphore(8);
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    private URI profileUrl;
    private String token;
    private volatile boolean ready;

    private record Identity(String name, UUID uuid) {}
    private record NativeApproval(Identity identity, long expiresAt, boolean consumed) {}

    @Inject
    public BrowserAuth(ProxyServer proxy, Logger logger, @DataDirectory Path dataDirectory) {
        this.proxy = proxy;
        this.logger = logger;
        this.dataDirectory = dataDirectory;
    }

    @Subscribe
    public void initialize(ProxyInitializeEvent ignored) {
        // Register deny-by-default handlers even when configuration is broken.
        proxy.getEventManager().register(this, new GatewayEvents());
        try (Reader reader = Files.newBufferedReader(dataDirectory.resolve("config.json"), StandardCharsets.UTF_8)) {
            JsonObject config = JSON.fromJson(reader, JsonObject.class);
            UUID.fromString(config.get("serverId").getAsString());
            URI candidate = URI.create(config.get("profileUrl").getAsString());
            if (!"http".equals(candidate.getScheme()) ||
                    !("127.0.0.1".equals(candidate.getHost()) || "[::1]".equals(candidate.getHost())) ||
                    candidate.getPort() < 1 || candidate.getUserInfo() != null ||
                    candidate.getQuery() != null || candidate.getFragment() != null || !"/open".equals(candidate.getPath())) {
                throw new IllegalArgumentException("A loopback profile endpoint is required.");
            }
            String candidateToken = config.get("token").getAsString();
            if (!candidateToken.matches("[a-fA-F0-9]{64}")) {
                throw new IllegalArgumentException("A scoped 32-byte gateway token is required.");
            }
            profileUrl = candidate;
            token = candidateToken;
            ready = true;
            logger.info("NODEPILOT_BROWSER_GATEWAY_READY");
        } catch (Exception error) {
            logger.error("Browser gateway profile configuration is invalid.");
        }
    }

    public final class GatewayEvents {
        @Subscribe(priority = Short.MAX_VALUE)
        public EventTask resolveGuestProfile(EaglercraftLoginEvent event) {
            if (event.isCancelled()) return null;
            if (!ready) {
                event.setKickMessage("NodePilot's browser gateway is starting. Try again shortly.");
                return null;
            }
            return EventTask.async(() -> {
                if (!requests.tryAcquire()) {
                    event.setKickMessage("The browser gateway is busy. Try again shortly.");
                    return;
                }
                try {
                    JsonObject body = new JsonObject();
                    body.addProperty("name", event.getProfileUsername());
                    HttpRequest request = HttpRequest.newBuilder(profileUrl)
                            .timeout(Duration.ofSeconds(5))
                            .header("Authorization", "Bearer " + token)
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                            .build();
                    HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
                    if (response.statusCode() == 409) {
                        event.setKickMessage("That name belongs to a Java player or server operator. Choose another player name.");
                        return;
                    }
                    if (response.statusCode() == 400) {
                        event.setKickMessage("Use a player name with 1-16 letters, numbers or underscores.");
                        return;
                    }
                    if (response.statusCode() != 200 || response.body().length() > 2048) {
                        event.setKickMessage("The browser gateway is unavailable. Try again shortly.");
                        return;
                    }
                    JsonObject result = JSON.fromJson(response.body(), JsonObject.class);
                    String name = result.get("name").getAsString();
                    UUID uuid = UUID.fromString(result.get("uuid").getAsString());
                    if (!result.get("ok").getAsBoolean() || !name.matches("[A-Za-z0-9_]{1,16}")) {
                        throw new IllegalArgumentException("Invalid guest identity");
                    }
                    approve(event, new Identity(name, uuid));
                } catch (Exception ignored) {
                    event.setKickMessage("The browser gateway could not load your player profile. Try again shortly.");
                } finally {
                    requests.release();
                }
            });
        }

        private void approve(EaglercraftLoginEvent event, Identity identity) {
            event.setProfileUsername(identity.name());
            event.setProfileUUID(identity.uuid());
            Channel channel = event.getLoginConnection().netty().getChannel();
            synchronized (approvedChannels) {
                long now = System.nanoTime();
                approvedChannels.entrySet().removeIf(entry -> entry.getValue().expiresAt() <= now);
                if (approvedChannels.size() >= 128) {
                    event.setKickMessage("The browser gateway is busy. Try again shortly.");
                    return;
                }
                approvedChannels.put(channel.id(), new NativeApproval(identity, now + TimeUnit.SECONDS.toNanos(10), false));
            }
            channel.closeFuture().addListener(ignored -> approvedChannels.remove(channel.id()));
        }

        @Subscribe(priority = Short.MAX_VALUE)
        public void routeBrowserConnection(PreLoginEvent event) {
            // Apply guest login only to the physical channel of the Eagler handshake.
            Channel channel = VelocityUnsafe.getInboundChannel(event.getConnection());
            NativeApproval approval = approvedChannels.get(channel.id());
            if (ready && approval != null && !approval.consumed() && approval.expiresAt() > System.nanoTime()
                    && approval.identity().name().equals(event.getUsername()) && event.getResult().isAllowed()
                    && approvedChannels.replace(channel.id(), approval, new NativeApproval(approval.identity(), approval.expiresAt(), true))) {
                event.setResult(PreLoginEvent.PreLoginComponentResult.forceOfflineMode());
            }
        }

        @Subscribe(priority = Short.MAX_VALUE)
        public void assignApprovedBrowserProfile(GameProfileRequestEvent event) {
            Channel channel = VelocityUnsafe.getInboundChannel(event.getConnection());
            NativeApproval approval = approvedChannels.remove(channel.id());
            if (approval == null || !approval.consumed()) return;
            if (!ready || approval.expiresAt() <= System.nanoTime()) {
                VelocityUnsafe.disconnectInbound(event.getConnection());
                return;
            }
            event.setGameProfile(event.getGameProfile().withId(approval.identity().uuid()).withName(approval.identity().name()));
        }
    }
}
