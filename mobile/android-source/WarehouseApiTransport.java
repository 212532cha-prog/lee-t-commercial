package my.leet.warehouse;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpCookie;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;

final class WarehouseApiTransport {
    private static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    private final URI origin;
    private final SSLSocketFactory sockets;
    private final String route;
    private final CookieManager cookies = new CookieManager(null, CookiePolicy.ACCEPT_ORIGINAL_SERVER);

    WarehouseApiTransport(String origin, String fingerprint, String route) throws Exception {
        this.route = route;
        if (WarehouseIdentityProbe.httpsOrigin(origin) == null) {
            throw new IllegalArgumentException("Invalid warehouse origin");
        }
        this.origin = new URI(origin);
        if (!this.origin.getRawPath().isEmpty() || this.origin.getRawQuery() != null ||
            this.origin.getRawFragment() != null) {
            throw new IllegalArgumentException("Use the warehouse origin without a path");
        }
        sockets = WarehouseIdentityProbe.socketFactory(fingerprint, route == null ? null : this.origin.getHost());
    }

    private static final String SESSION_COOKIE = "__Host-warehouse_session";
    private static final String DEVICE_COOKIE = "__Host-leet_device";

    void restoreDevice(String token) throws IOException {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) return;
        cookies.put(origin, Collections.singletonMap("Set-Cookie", Collections.singletonList(
            DEVICE_COOKIE + "=" + token + "; Path=/; Secure; HttpOnly")));
    }

    String deviceToken() {
        return cookieValue(DEVICE_COOKIE);
    }

    private String cookieValue(String name) {
        String value = null;
        for (HttpCookie cookie : cookies.getCookieStore().get(origin)) {
            if (!name.equals(cookie.getName()) || !cookie.getSecure() || !cookie.isHttpOnly() ||
                !"/".equals(cookie.getPath()) || !cookie.getValue().matches("[A-Za-z0-9_-]{43}")) continue;
            if (value != null) return null;
            value = cookie.getValue();
        }
        return value;
    }

    byte[] readPhoto(String path) throws Exception {
        if (!path.matches("/api/products/[a-fA-F0-9-]{36}/photo")) return null;
        HttpsURLConnection connection = connection(endpoint(path), "image/jpeg,image/png");
        try {
            if (connection.getResponseCode() != 200) return null;
            String type = connection.getContentType();
            if (!"image/jpeg".equals(type) && !"image/png".equals(type)) return null;
            try (InputStream input = connection.getInputStream()) {
                return readBytes(input, 5 * 1024 * 1024);
            }
        } finally {
            connection.disconnect();
        }
    }

    private URI endpoint(String path) throws Exception {
        if (path == null || !path.startsWith("/api/") || path.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("Invalid warehouse API path");
        }
        URI relative = new URI(path);
        if (relative.isAbsolute() || relative.getRawAuthority() != null || relative.getRawFragment() != null ||
            !relative.normalize().equals(relative) || !relative.getPath().startsWith("/api/") ||
            !new URI(null, null, relative.getPath(), null).normalize().getPath().equals(relative.getPath())) {
            throw new IllegalArgumentException("Invalid warehouse API path");
        }
        return origin.resolve(relative);
    }

    WarehouseIdentityProbe.Response request(String method, String path, String body, String csrf) throws Exception {
        if (!"GET".equals(method) && !"POST".equals(method) && !"PUT".equals(method) && !"DELETE".equals(method)) {
            throw new IllegalArgumentException("Unsupported warehouse API method");
        }
        URI url = endpoint(path);
        byte[] payload = body == null ? null : body.getBytes(StandardCharsets.UTF_8);
        if (payload != null && ("GET".equals(method) || payload.length > MAX_JSON_BYTES)) {
            throw new IllegalArgumentException("Invalid warehouse API body");
        }
        HttpsURLConnection connection = connection(url, "application/json");
        try {
            connection.setRequestMethod(method);
            if (csrf != null) connection.setRequestProperty("X-CSRF-Token", csrf);
            if (payload != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(payload.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(payload);
                }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new IOException("Warehouse API redirects are disabled");
            try (InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                String json = stream == null ? "" : new String(readBytes(stream, MAX_JSON_BYTES), StandardCharsets.UTF_8);
                cookies.put(url, connection.getHeaderFields());
                return new WarehouseIdentityProbe.Response(status, url.toString(), json);
            }
        } finally {
            connection.disconnect();
        }
    }

    private HttpsURLConnection connection(URI url, String accept) throws Exception {
        HttpsURLConnection connection = WarehouseIdentityProbe.open(url, sockets, route);
        connection.setRequestProperty("Accept", accept);
        connection.setRequestProperty("Origin", origin.toString());
        // CookieManager can emit RFC 2965 quotes and $Version for Max-Age cookies.
        // The warehouse expects the same unquoted name=value tokens sent by a browser.
        String session = cookieValue(SESSION_COOKIE);
        String device = deviceToken();
        if (session != null || device != null) {
            String header = session == null ? "" : SESSION_COOKIE + "=" + session;
            if (device != null) header += (header.isEmpty() ? "" : "; ") + DEVICE_COOKIE + "=" + device;
            connection.setRequestProperty("Cookie", header);
        }
        return connection;
    }

    Events openEvents(String path) throws Exception {
        URI url = endpoint(path);
        HttpsURLConnection connection = connection(url, "text/event-stream");
        try {
            String type = connection.getContentType();
            if (connection.getResponseCode() != 200 || type == null ||
                !"text/event-stream".equalsIgnoreCase(type.split(";", 2)[0].trim())) {
                throw new IOException("Warehouse event stream was rejected");
            }
            return new Events(connection, connection.getInputStream());
        } catch (Exception failure) {
            connection.disconnect();
            throw failure;
        }
    }

    static final class Events implements AutoCloseable {
        private final HttpsURLConnection connection;
        private final InputStream input;

        Events(HttpsURLConnection connection, InputStream input) {
            this.connection = connection;
            this.input = new java.io.BufferedInputStream(input);
        }

        String readEvent() throws IOException {
            StringBuilder data = new StringBuilder();
            while (true) {
                ByteArrayOutputStream line = new ByteArrayOutputStream();
                int next;
                while ((next = input.read()) != -1 && next != '\n') {
                    if (line.size() >= 4096) throw new IOException("Warehouse event is too large");
                    if (next != '\r') line.write(next);
                }
                if (next == -1) return null;
                String text = new String(line.toByteArray(), StandardCharsets.UTF_8);
                if (text.isEmpty() && data.length() > 0) return data.toString();
                if (text.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(text.substring(text.startsWith("data: ") ? 6 : 5));
                    if (data.length() > 4096) throw new IOException("Warehouse event is too large");
                }
            }
        }

        @Override
        public void close() throws IOException {
            connection.disconnect();
            input.close();
        }
    }

    private static byte[] readBytes(InputStream stream, int maxBytes) throws IOException {
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = stream.read(buffer)) != -1) {
            if (result.size() + count > maxBytes) throw new IOException("Warehouse API response is too large");
            result.write(buffer, 0, count);
        }
        return result.toByteArray();
    }
}
