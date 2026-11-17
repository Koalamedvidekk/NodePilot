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
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import io.netty.channel.Channel;
import io.netty.channel.ChannelId;
import net.lax1dude.eaglercraft.backend.server.api.IEaglerLoginConnection;
import net.lax1dude.eaglercraft.backend.server.api.event.IEaglercraftAuthCheckRequiredEvent.EnumAuthResponse;
import net.lax1dude.eaglercraft.backend.server.api.event.IEaglercraftAuthCheckRequiredEvent.EnumAuthType;
import net.lax1dude.eaglercraft.backend.server.api.velocity.event.EaglercraftAuthCheckRequiredEvent;
import net.lax1dude.eaglercraft.backend.server.api.velocity.event.EaglercraftAuthPasswordEvent;
import net.lax1dude.eaglercraft.backend.server.api.velocity.event.EaglercraftLoginEvent;
import net.lax1dude.eaglercraft.backend.server.velocity.VelocityUnsafe;
import org.slf4j.Logger;

public final class BrowserAuth {
    private static final Gson JSON = new Gson();
    private static final String DENIED = "Browser login failed. Check your NodePilot account and password.";
    private final ProxyServer proxy;
    private final Logger logger;
    private final Path dataDirectory;
    private final Map<IEaglerLoginConnection, Identity> approved = Collections.synchronizedMap(new WeakHashMap<>());
    private final Map<ChannelId, NativeApproval> approvedChannels = new ConcurrentHashMap<>();
    private final Semaphore requests = new Semaphore(8);
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    private URI verifyUrl;
    private String token;
    private boolean requirePassword = true;
    private volatile boolean ready;

    private record Identity(String name, UUID uuid) {}
    private record NativeApproval(Identity identity, long expiresAt, boolean consumed) {}

    static String decodePassword(byte[] supplied) throws CharacterCodingException {
        if (supplied.length < 4 || supplied.length > 255) {
            throw new CharacterCodingException();
        }
        // The verified Eaglercraft 1.8-u53 PLAINTEXT handshake sends UTF-8 bytes.
        String password = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(supplied)).toString();
        if (password.length() < 4 || password.length() > 127 || password.trim().isEmpty()) {
            throw new CharacterCodingException();
        }
        return password;
    }

    @Inject
    public BrowserAuth(ProxyServer proxy, Logger logger, @DataDirectory Path dataDirectory) {
        this.proxy = proxy;
        this.logger = logger;
        this.dataDirectory = dataDirectory;
    }

    @Subscribe
    public void initialize(ProxyInitializeEvent ignored) {
        // Register deny-by-default handlers even when configuration is broken.
        proxy.getEventManager().register(this, new Authentication());
        try (Reader reader = Files.newBufferedReader(dataDirectory.resolve("config.json"), StandardCharsets.UTF_8)) {
            JsonObject config = JSON.fromJson(reader, JsonObject.class);
            UUID.fromString(config.get("serverId").getAsString());
            URI candidate = URI.create(config.get("verifyUrl").getAsString());
            if (!"http".equals(candidate.getScheme()) ||
                    !("127.0.0.1".equals(candidate.getHost()) || "[::1]".equals(candidate.getHost())) ||
                    candidate.getPort() < 1 || candidate.getUserInfo() != null ||
                    candidate.getQuery() != null || candidate.getFragment() != null) {
                throw new IllegalArgumentException("A loopback verification endpoint is required.");
            }
            String candidateToken = config.get("token").getAsString();
            if (!candidateToken.matches("[a-fA-F0-9]{64}")) {
                throw new IllegalArgumentException("A scoped 32-byte verification token is required.");
            }
            verifyUrl = candidate;
            token = candidateToken;
            requirePassword = !config.has("requirePassword") || config.get("requirePassword").getAsBoolean();
            ready = true;
            logger.info("NODEPILOT_BROWSER_AUTH_READY");
        } catch (Exception error) {
            logger.error("Browser authentication is disabled because its local configuration is invalid.");
        }
    }

    public final class Authentication {
        @Subscribe(priority = Short.MAX_VALUE)
        public void requirePassword(EaglercraftAuthCheckRequiredEvent event) {
            event.setNicknameSelectionEnabled(false);
            event.setEnableCookieAuth(false);
            if (!ready) {
                event.kickUser("NodePilot browser authentication is unavailable.");
                return;
            }
            if (!requirePassword) {
                event.setAuthRequired(EnumAuthResponse.SKIP);
                return;
            }
            event.setUseAuthType(EnumAuthType.PLAINTEXT);
            event.setAuthMessage("Enter the password for your NodePilot browser account.");
            event.setAuthRequired(EnumAuthResponse.REQUIRE);
        }

        @Subscribe(priority = Short.MAX_VALUE)
        public EventTask verifyPassword(EaglercraftAuthPasswordEvent event) {
            event.setLoginDenied(DENIED);
            byte[] supplied = event.getAuthPasswordDataResponse();
            byte[] authName = event.getAuthUsername();
            if (!ready || !requirePassword || event.getAuthType() != EnumAuthType.PLAINTEXT ||
                    supplied.length < 4 || supplied.length > 255 || authName.length > 64) {
                return null;
            }
            return EventTask.async(() -> {
                if (!requests.tryAcquire()) return;
                try {
                    String name = new String(authName, StandardCharsets.UTF_8);
                    if (!name.matches("(?:np_)?[A-Za-z0-9_]{1,13}")) return;
                    JsonObject body = new JsonObject();
                    body.addProperty("name", name);
                    body.addProperty("password", decodePassword(supplied));
                    HttpRequest request = HttpRequest.newBuilder(verifyUrl)
                            .timeout(Duration.ofSeconds(5))
                            .header("Authorization", "Bearer " + token)
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                            .build();
                    // The local verifier controls the response. Never follow redirects or log credentials.
                    HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
                    if (response.statusCode() != 200 || response.body().length() > 2048) return;
                    JsonObject result = JSON.fromJson(response.body(), JsonObject.class);
                    if (!result.has("ok") || !result.get("ok").getAsBoolean()) return;
                    String profile = result.get("name").getAsString();
                    UUID uuid = UUID.fromString(result.get("uuid").getAsString());
                    if (!profile.matches("np_[A-Za-z0-9_]{1,13}")) return;
                    approved.put(event.getLoginConnection(), new Identity(profile, uuid));
                    event.setProfileUsername(profile);
                    event.setProfileUUID(uuid);
                    event.setLoginAllowed();
                } catch (Exception ignored) {
                    // Timeout, invalid response and verifier failure all retain DENY.
                } finally {
                    requests.release();
                }
            });
        }

        @Subscribe(priority = Short.MAX_VALUE)
        public EventTask requireApprovedIdentity(EaglercraftLoginEvent event) {
            if (event.isCancelled()) return null;
            if (ready && !requirePassword) {
                return EventTask.async(() -> {
                    if (!requests.tryAcquire()) {
                        event.setKickMessage("Browser login is busy. Try again shortly.");
                        return;
                    }
                    try {
                        JsonObject body = new JsonObject();
                        body.addProperty("name", event.getProfileUsername());
                        HttpRequest request = HttpRequest.newBuilder(verifyUrl.resolve("/open"))
                                .timeout(Duration.ofSeconds(5))
                                .header("Authorization", "Bearer " + token)
                                .header("Content-Type", "application/json")
                                .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                                .build();
                        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
                        if (response.statusCode() != 200 || response.body().length() > 2048) throw new IllegalStateException();
                        JsonObject result = JSON.fromJson(response.body(), JsonObject.class);
                        if (!result.has("ok") || !result.get("ok").getAsBoolean()) throw new IllegalStateException();
                        String name = result.get("name").getAsString();
                        if (!name.matches("np_[A-Za-z0-9_]{1,13}")) throw new IllegalStateException();
                        approve(event, new Identity(name, UUID.fromString(result.get("uuid").getAsString())));
                    } catch (Exception ignored) {
                        event.setKickMessage("Browser login unavailable. Use 1-13 letters, numbers or underscores; revoked and reserved names cannot join.");
                    } finally {
                        requests.release();
                    }
                });
            }
            Identity identity = approved.remove(event.getLoginConnection());
            if (!ready || identity == null) {
                event.setKickMessage(DENIED);
                return null;
            }
            approve(event, identity);
            return null;
        }

        private void approve(EaglercraftLoginEvent event, Identity identity) {
            event.setProfileUsername(identity.name());
            event.setProfileUUID(identity.uuid());
            Channel channel = event.getLoginConnection().netty().getChannel();
            synchronized (approvedChannels) {
                long now = System.nanoTime();
                approvedChannels.entrySet().removeIf(entry -> entry.getValue().expiresAt() <= now);
                if (approvedChannels.size() >= 128) {
                    event.setKickMessage("Browser authentication is busy. Try again shortly.");
                    return;
                }
                approvedChannels.put(channel.id(), new NativeApproval(identity, now + TimeUnit.SECONDS.toNanos(10), false));
            }
            channel.closeFuture().addListener(ignored -> approvedChannels.remove(channel.id()));
        }

        @Subscribe(priority = Short.MAX_VALUE)
        public void authenticateBrowserConnection(PreLoginEvent event) {
            // A username never authorizes offline login. Consume a successful Eagler
            // authentication tied to this exact physical channel and selected identity.
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
