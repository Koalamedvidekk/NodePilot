package dev.nodepilot.browser;

import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;

public final class PasswordDecodingTest {
    public static void main(String[] args) throws Exception {
        for (String password : new String[] { "1234", "äbcд", "fixture-password-123", "příliš-žluťoučký-123", "emoji-🔐-password" }) {
            String actual = BrowserAuth.decodePassword(password.getBytes(StandardCharsets.UTF_8));
            if (!password.equals(actual)) throw new AssertionError("The handshake password did not round trip.");
        }
        rejects("abc".getBytes(StandardCharsets.UTF_8));
        rejects("    ".getBytes(StandardCharsets.UTF_8));
        rejects(new byte[258]);
        rejects("x".repeat(128).getBytes(StandardCharsets.UTF_8));
        rejects("界".repeat(86).getBytes(StandardCharsets.UTF_8));
        if (BrowserAuth.decodePassword("x".repeat(127).getBytes(StandardCharsets.UTF_8)).length() != 127) {
            throw new AssertionError("Maximum supported protocol password was rejected.");
        }
        byte[] malformed = "fixture-password-123".getBytes(StandardCharsets.UTF_8);
        malformed[0] = (byte) 0xD8;
        malformed[1] = 0;
        rejects(malformed);
        System.out.println("PASS Eagler UTF-8 password decoding and malformed input rejection");
    }

    private static void rejects(byte[] bytes) throws Exception {
        try {
            BrowserAuth.decodePassword(bytes);
            throw new AssertionError("Invalid password encoding was accepted.");
        } catch (CharacterCodingException expected) {}
    }
}
