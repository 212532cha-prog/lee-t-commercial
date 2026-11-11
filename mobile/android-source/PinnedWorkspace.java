package my.leet.warehouse;

import android.util.AtomicFile;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class PinnedWorkspace {
    private final WebView view;
    private final WarehouseApiTransport transport;
    private static final long DEVICE_LIFETIME = 400L * 24 * 60 * 60 * 1000;
    private final AtomicFile deviceFile;
    private final AdministratorStorage administratorStorage;
    private JSONObject administratorRecord;
    private long nextInventorySync;
    private final ExecutorService requests = Executors.newSingleThreadExecutor();
    private final ExecutorService eventThread = Executors.newSingleThreadExecutor();
    private final Map<String, EventJob> streams = new ConcurrentHashMap<>();
    private volatile boolean closed;

    PinnedWorkspace(WebView view, String origin, String fingerprint, String route, boolean administrator) throws Exception {
        this.view = view;
        transport = new WarehouseApiTransport(origin, fingerprint, route);
        deviceFile = new AtomicFile(new File(view.getContext().getNoBackupFilesDir(), "warehouse-" + fingerprint));
        administratorStorage = administrator ? new AdministratorStorage(view.getContext(), origin, fingerprint) : null;
        if (administratorStorage != null) {
            administratorRecord = administratorStorage.read();
            if (administratorRecord != null) transport.restoreSession(administratorRecord.getString("token"));
        }
        try {
            String[] stored = new String(deviceFile.readFully(), StandardCharsets.UTF_8).split("\n", 2);
            if (stored.length == 2 && Long.parseLong(stored[0]) > System.currentTimeMillis()) {
                transport.restoreDevice(stored[1]);
            }
        } catch (IOException | NumberFormatException ignored) {
            // The employee will pair again if the device token cannot be read.
        }
    }

    private void clearAdministrator() {
        administratorRecord = null;
        if (administratorStorage != null) administratorStorage.clear();
    }

    private void rememberAdministrator(String body) throws Exception {
        if (administratorStorage == null) return;
        clearAdministrator();
        String token = transport.sessionToken();
        if (token == null || !"admin".equals(new JSONObject(body).getJSONObject("user").getString("role"))) return;
        JSONObject record = AdministratorStorage.newSession(token);
        administratorStorage.save(record);
        administratorRecord = record;
        nextInventorySync = 0;
    }

    private void refreshOfflineInventory() throws Exception {
        if (administratorRecord == null || SystemClock.elapsedRealtime() < nextInventorySync) return;
        nextInventorySync = SystemClock.elapsedRealtime() + 60_000;
        WarehouseIdentityProbe.Response result = transport.request("GET", "/api/products/offline-inventory", null, null);
        if (result.status == 401 || result.status == 403) {
            clearAdministrator();
        } else if (result.status == 200) {
            administratorStorage.saveInventory(administratorRecord.getString("token"), new JSONObject(result.body));
        }
    }

    private void saveDevice(String token) throws IOException {
        FileOutputStream output = deviceFile.startWrite();
        try {
            String record = (System.currentTimeMillis() + DEVICE_LIFETIME) + "\n" + token;
            output.write(record.getBytes(StandardCharsets.UTF_8));
            deviceFile.finishWrite(output);
        } catch (IOException failure) {
            deviceFile.failWrite(output);
            throw failure;
        }
    }

    private void deliver(String id, String type, int status, String body) {
        view.post(() -> {
            if (!closed) view.evaluateJavascript("window.leetNativeReceive(" + JSONObject.quote(id) + "," +
                JSONObject.quote(type) + "," + status + "," + JSONObject.quote(body == null ? "" : body) + ")", null);
        });
    }

    @JavascriptInterface
    public void request(String id, String method, String path, String body, String csrf) {
        if (closed || !id.matches("[0-9]{1,12}")) return;
        requests.execute(() -> {
            if ("/api/auth/logout".equals(path) && "POST".equals(method)) clearAdministrator();
            try {
                WarehouseIdentityProbe.Response response = transport.request(method, path, body, csrf);
                if (administratorRecord != null &&
                        (!administratorRecord.optString("token").equals(transport.sessionToken()) ||
                        (response.status == 401 && ("/api/me".equals(path) || "/api/state".equals(path))))) {
                    clearAdministrator();
                }
                if ("/api/auth/login".equals(path) && response.status == 200) {
                    String device = transport.deviceToken();
                    if (device != null) {
                        try { saveDevice(device); } catch (IOException ignored) {}
                    }
                    try { rememberAdministrator(response.body); } catch (Exception ignored) {
                        // Secure storage may be unavailable. The online session still works.
                    }
                }
                deliver(id, "response", response.status, response.body);
                if ("/api/state".equals(path) && response.status == 200) {
                    try { refreshOfflineInventory(); } catch (Exception ignored) {
                        // A failed synchronization must not affect live warehouse access.
                    }
                }
            } catch (Exception failure) {
                deliver(id, "error", 0, "");
            }
        });
    }

    @JavascriptInterface
    public void events(String id, String path) {
        if (closed || !id.matches("[0-9]{1,12}")) return;
        EventJob job = new EventJob();
        if (streams.putIfAbsent(id, job) != null) return;
        eventThread.execute(() -> {
            try {
                if (job.cancelled) return;
                try (WarehouseApiTransport.Events events = transport.openEvents(path)) {
                    job.events = events;
                    while (!job.cancelled) {
                        String event = events.readEvent();
                        if (event == null) break;
                        deliver(id, "event", 0, event);
                    }
                }
            } catch (Exception ignored) {
                // The existing count UI handles connection loss.
            } finally {
                streams.remove(id, job);
                if (!job.cancelled) deliver(id, "error", 0, "");
            }
        });
    }

    @JavascriptInterface
    public void closeEvents(String id) {
        EventJob job = streams.remove(id);
        if (job != null) job.cancel();
    }

    WebResourceResponse resource(URI uri) {
        try {
            String path = uri.getPath();
            if (path.startsWith("/api/")) {
                byte[] photo = transport.readPhoto(path);
                if (photo != null && photo.length > 0) return new WebResourceResponse(photo[0] == (byte) 0x89 ? "image/png" : "image/jpeg", null, new ByteArrayInputStream(photo));
            } else {
                String name = "/".equals(path) ? "index.html" : path.substring(1);
                if (name.matches("(?:[a-z-]+\\.js|index\\.html|app\\.css|vendor/jsqr\\.js|fonts/business-regular\\.woff2)")) {
                    String mime = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".woff2") ? "font/woff2" : "text/html";
                    return new WebResourceResponse(mime, "UTF-8", 200, "OK", Collections.singletonMap(
                        "Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; " +
                        "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"),
                        view.getContext().getAssets().open("warehouse/" + name));
                }
            }
        } catch (Exception ignored) {
            // Unknown resources remain blocked instead of reaching a remote WebView origin.
        }
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(),
            new ByteArrayInputStream(new byte[0]));
    }

    void close() {
        closed = true;
        for (EventJob job : streams.values()) job.cancel();
        streams.clear();
        requests.shutdownNow();
        eventThread.shutdownNow();
    }

    private static final class EventJob {
        volatile WarehouseApiTransport.Events events;
        volatile boolean cancelled;

        void cancel() {
            cancelled = true;
            WarehouseApiTransport.Events stream = events;
            if (stream != null) {
                try { stream.close(); } catch (Exception ignored) {}
            }
        }
    }
}
