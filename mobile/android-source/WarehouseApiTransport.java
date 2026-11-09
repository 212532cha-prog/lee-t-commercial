package my.leet.warehouse;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;

final class WarehouseApiTransport {
    private static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    private final URI origin;
    private final SSLSocketFactory sockets;
    private final String route;
    private volatile String sessionToken;
    private volatile String deviceToken;

    static void useNativeCookieOwnership() {
        // Capacitor installs a process-wide WebView cookie handler even with its
        // JavaScript cookie plugin disabled. It can append a second session
        // cookie to the explicit header below, which the server rejects.
        CookieHandler.setDefault(null);
    }

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

    void restoreDevice(String token) {
        if (validToken(token)) deviceToken = token;
    }

    String deviceToken() {
        return deviceToken;
    }

    boolean hasSession() {
        return sessionToken != null;
    }

    private static boolean validToken(String token) {
        return token != null && token.matches("[A-Za-z0-9_-]{43}");
    }

    // Only the pinned warehouse can supply these two host-only cookies.
    private static String responseToken(Map<String, List<String>> headers, String name, String current) {
        String next = current;
        boolean seen = false;
        for (Map.Entry<String, List<String>> header : headers.entrySet()) {
            if (!"Set-Cookie".equalsIgnoreCase(header.getKey())) continue;
            for (String value : header.getValue()) {
                String[] parts = value.split(";", -1);
                String pair = parts[0].trim();
                if (!pair.startsWith(name + "=")) continue;
                if (seen) return null;
                seen = true;
                String token = pair.substring(name.length() + 1);
                boolean secure = false, httpOnly = false, root = false, cleared = false;
                for (int i = 1; i < parts.length; i++) {
                    String attribute = parts[i].trim();
                    if (attribute.equalsIgnoreCase("Secure")) secure = true;
                    else if (attribute.equalsIgnoreCase("HttpOnly")) httpOnly = true;
                    else if (attribute.equalsIgnoreCase("Path=/")) root = true;
                    else if (attribute.equalsIgnoreCase("Max-Age=0")) cleared = true;
                    else if (attribute.regionMatches(true, 0, "Domain=", 0, 7)) return null;
                }
                next = secure && httpOnly && root && !cleared && validToken(token) ? token : null;
            }
        }
        return next;
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
                Map<String, List<String>> headers = connection.getHeaderFields();
                sessionToken = responseToken(headers, SESSION_COOKIE, sessionToken);
                deviceToken = responseToken(headers, DEVICE_COOKIE, deviceToken);
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
        String session = sessionToken;
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
