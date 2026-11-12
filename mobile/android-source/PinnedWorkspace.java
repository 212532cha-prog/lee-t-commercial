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
    private final boolean administratorEntry;
    private volatile String offlineStatus = "{\"state\":\"none\"}";
    private final ExecutorService requests = Executors.newSingleThreadExecutor();
    private final ExecutorService eventThread = Executors.newSingleThreadExecutor();
    private final Map<String, EventJob> streams = new ConcurrentHashMap<>();
    private volatile boolean closed;
    private final Map<String, Upload> uploads = new ConcurrentHashMap<>();

    PinnedWorkspace(WebView view, String origin, String fingerprint, String route, boolean administrator) throws Exception {
        this.view = view;
        transport = new WarehouseApiTransport(origin, fingerprint, route);
        deviceFile = new AtomicFile(new File(view.getContext().getNoBackupFilesDir(), "warehouse-" + fingerprint));
        administratorEntry = administrator;
        AdministratorStorage storage;
        try { storage = new AdministratorStorage(view.getContext(), origin, fingerprint); }
        catch (Exception unavailable) { storage = null; }
        administratorStorage = storage;
        if (administrator && administratorStorage != null) {
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
        String token = transport.sessionToken();
        if (token == null || !"admin".equals(new JSONObject(body).getJSONObject("user").getString("role"))) return;
        if (administratorStorage == null) { syncStatus("unavailable", null); return; }
        JSONObject record = AdministratorStorage.newSession(token);
        administratorStorage.save(record);
        administratorRecord = record;
        nextInventorySync = 0;
    }

    @JavascriptInterface
    public void closeWorkspace() { view.post(() -> ((WarehouseActivity) view.getContext()).finish()); }

    @JavascriptInterface
    public String entryRole() { return administratorEntry ? "admin" : "employee"; }

    @JavascriptInterface
    public String offlineStatus() { return offlineStatus; }

    private void syncStatus(String state, String time) {
        try {
            JSONObject value = new JSONObject().put("state", state);
            if (time != null) value.put("synchronizedAt", time);
            offlineStatus = value.toString();
            view.post(() -> {
                if (!closed) view.evaluateJavascript("window.dispatchEvent(new CustomEvent('leet-offline-status',{detail:" + offlineStatus + "}))", null);
            });
        } catch (Exception ignored) {}
    }

    @JavascriptInterface
    public void syncInventory() {
        if (closed) return;
        requests.execute(() -> { nextInventorySync = 0; refreshOfflineInventory(); });
    }

    private void refreshOfflineInventory() {
        if (administratorRecord == null || SystemClock.elapsedRealtime() < nextInventorySync) return;
        nextInventorySync = SystemClock.elapsedRealtime() + 5_000;
        syncStatus("syncing", null);
        try {
            WarehouseIdentityProbe.Response result = transport.request("GET", "/api/products/offline-inventory", null, null);
            if (result.status == 401 || result.status == 403) {
                clearAdministrator();
                syncStatus("expired", null);
            } else if (result.status == 200) {
                JSONObject inventory = new JSONObject(result.body);
                administratorStorage.saveInventory(administratorRecord.getString("token"), inventory);
                nextInventorySync = SystemClock.elapsedRealtime() + 60_000;
                syncStatus("saved", inventory.getString("synchronizedAt"));
            } else { syncStatus("failed", null); }
        } catch (Exception failure) { syncStatus("failed", null); }
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

    void deliver(String id, String type, int status, String body) {
        view.post(() -> {
            if (!closed) view.evaluateJavascript("window.leetNativeReceive(" + JSONObject.quote(id) + "," +
                JSONObject.quote(type) + "," + status + "," + JSONObject.quote(body == null ? "" : body) + ")", null);
        });
    }

    @JavascriptInterface
    public void request(String id, String method, String path, String body, String csrf) {
        requestWithHeaders(id, method, path, body, csrf, "{}");
    }

    @JavascriptInterface
    public void requestWithHeaders(String id, String method, String path, String body, String csrf, String extra) {
        if (closed || !id.matches("[0-9]{1,12}")) return;
        requests.execute(() -> {
            if ("/api/auth/logout".equals(path) && "POST".equals(method) && administratorRecord != null) clearAdministrator();
            try {
                WarehouseIdentityProbe.Response response = transport.request(method, path, body, csrf, headers(extra));
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
                        syncStatus("unavailable", null);
                    }
                }
                deliver(id, "response", response.status, response.body);
                if (response.status == 200 && ("/api/auth/login".equals(path) || "/api/me".equals(path) || "/api/state".equals(path))) refreshOfflineInventory();
            } catch (Exception failure) {
                deliver(id, "error", 0, "");
            }
        });
    }

    private static Map<String, String> headers(String extra) throws Exception {
        JSONObject value = new JSONObject(extra);
        Map<String, String> result = new java.util.HashMap<>();
        var keys = value.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!java.util.Arrays.asList("X-Confirm-Permanent", "X-Import-Preview").contains(key)) throw new IllegalArgumentException("Invalid header");
            result.put(key, value.getString(key));
        }
        return result;
    }

    @JavascriptInterface
    public String beginUpload(String path, String type, long length, String csrf) throws Exception {
        if (closed || !uploads.isEmpty() || length < 0) throw new IllegalStateException("Upload busy");
        boolean photo = path != null && (path.matches("/api/products/[a-fA-F0-9-]{36}/photo") || path.equals("/api/me/avatar"));
        if (!(photo && ("image/jpeg".equals(type) || "image/png".equals(type)) && length <= 5 * 1024 * 1024) &&
            !("/api/backups/upload".equals(path) && "application/octet-stream".equals(type))) throw new IllegalArgumentException("Invalid upload");
        File file = File.createTempFile("leet-upload-", ".tmp", view.getContext().getCacheDir());
        if (length > file.getUsableSpace()) { file.delete(); throw new IOException("Insufficient phone storage"); }
        String id = java.util.UUID.randomUUID().toString();
        uploads.put(id, new Upload(file, path, type, length, csrf));
        return id;
    }

    @JavascriptInterface
    public void appendUpload(String id, long offset, String base64) throws Exception {
        Upload upload = uploads.get(id);
        if (upload == null || closed || base64.length() > 350_000) throw new IOException("Invalid upload chunk");
        byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        synchronized (upload) {
            if (upload.sending || offset != upload.file.length() || offset + bytes.length > upload.length) throw new IOException("Invalid upload offset");
            try (FileOutputStream output = new FileOutputStream(upload.file, true)) { output.write(bytes); }
        }
    }

    @JavascriptInterface
    public void cancelUpload(String id) {
        Upload upload = uploads.get(id);
        if (upload != null) synchronized (upload) {
            if (!upload.sending) { uploads.remove(id); upload.file.delete(); }
        }
    }

    @JavascriptInterface
    public void finishUpload(String requestId, String id) {
        Upload upload = uploads.get(id);
        if (closed || upload == null || !requestId.matches("[0-9]{1,12}")) return;
        synchronized (upload) {
            if (upload.sending || upload.file.length() != upload.length) { deliver(requestId, "error", 0, ""); return; }
            upload.sending = true;
        }
        requests.execute(() -> {
            try {
                var response = transport.upload(upload.path, upload.type, upload.file, upload.csrf);
                deliver(requestId, "response", response.status, response.body);
                nextInventorySync = 0;
            } catch (Exception failure) { deliver(requestId, "error", 0, ""); }
            finally { uploads.remove(id); upload.file.delete(); }
        });
    }

    private static final class Upload {
        final File file;
        final String path, type, csrf;
        final long length;
        boolean sending;
        Upload(File file, String path, String type, long length, String csrf) {
            this.file = file; this.path = path; this.type = type; this.length = length; this.csrf = csrf;
        }
    }

    @JavascriptInterface
    public void download(String id, String path, boolean print) {
        if (closed || !id.matches("[0-9]{1,12}")) return;
        requests.execute(() -> {
            File file = null;
            try {
                if (print && !path.matches("/api/products/(?:[a-fA-F0-9-]{36}/qr/print|qr/print-batch\\?.+)")) throw new IOException("Invalid print path");
                file = File.createTempFile("leet-download-", ".tmp", view.getContext().getCacheDir());
                String type = transport.download(path, file);
                if (closed) { file.delete(); return; }
                File ready = file;
                view.post(() -> ((WarehouseActivity) view.getContext()).saveDownload(id, ready, type, print));
            } catch (Exception failure) {
                if (file != null) file.delete();
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
                byte[] photo = transport.readPhoto(path + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()));
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
        for (String id : uploads.keySet()) cancelUpload(id);
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
