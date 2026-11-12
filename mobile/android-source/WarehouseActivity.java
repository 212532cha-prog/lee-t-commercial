package my.leet.warehouse;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.util.Collections;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.util.Arrays;

public class WarehouseActivity extends Activity {
    private static final int CAMERA_PERMISSION = 1;
    private static final String LOCAL_ORIGIN = "https://appassets.androidplatform.net";
    private WebView workspace;
    private PinnedWorkspace pinned;
    private String warehouseOrigin;
    private PermissionRequest pendingCamera;
    private android.webkit.ValueCallback<android.net.Uri[]> fileSelection;
    private java.io.File downloadFile;
    private String downloadId;
    private WebView printView;

    private void showError() {
        android.widget.LinearLayout panel = new android.widget.LinearLayout(this);
        panel.setOrientation(android.widget.LinearLayout.VERTICAL);
        panel.setPadding(32, 64, 32, 32);
        android.widget.TextView text = new android.widget.TextView(this);
        text.setText("Warehouse could not open / 无法打开仓库 / Gudang tidak dapat dibuka\n\nCheck Wi-Fi and keep the warehouse computer running.\n请检查 Wi-Fi，并保持仓库电脑运行。");
        panel.addView(text);
        android.widget.Button retry = new android.widget.Button(this);
        retry.setText("Retry / 重试 / Cuba lagi");
        retry.setOnClickListener(v -> recreate());
        panel.addView(retry);
        android.widget.Button back = new android.widget.Button(this);
        back.setText("Back / 返回 / Kembali");
        back.setOnClickListener(v -> finish());
        panel.addView(back);
        setContentView(panel);
    }

    void saveDownload(String id, java.io.File file, String contentType, boolean print) {
        if (isFinishing() || isDestroyed() || downloadFile != null || printView != null) {
            file.delete(); pinned.deliver(id, "error", 0, ""); return;
        }
        if (print) {
            try {
                if (file.length() > 2 * 1024 * 1024 || contentType == null || !contentType.startsWith("text/html")) throw new java.io.IOException();
                String html = new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8);
                printView = new WebView(this);
                printView.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        return pinned.resource(URI.create(request.getUrl().toString()));
                    }
                    @Override public void onPageFinished(WebView view, String url) {
                        android.print.PrintManager printer = (android.print.PrintManager) getSystemService(PRINT_SERVICE);
                        printer.print("LEE T QR labels", view.createPrintDocumentAdapter("LEE T QR labels"), new android.print.PrintAttributes.Builder().build());
                        pinned.deliver(id, "response", 200, "{\"printing\":true}");
                    }
                });
                printView.loadDataWithBaseURL(LOCAL_ORIGIN + "/", html, "text/html", "UTF-8", null);
            } catch (Exception failure) { pinned.deliver(id, "error", 0, ""); }
            finally { file.delete(); }
            return;
        }
        try {
            String type = contentType == null ? "application/octet-stream" : contentType.split(";", 2)[0];
            String extension = type.equals("image/png") ? ".png" : type.equals("application/pdf") ? ".pdf" :
                type.contains("spreadsheetml") ? ".xlsx" : type.equals("application/json") ? ".json" : ".whb";
            downloadFile = file; downloadId = id;
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(android.content.Intent.CATEGORY_OPENABLE).setType(type)
                .putExtra(android.content.Intent.EXTRA_TITLE, "LEE-T-" + System.currentTimeMillis() + extension);
            startActivityForResult(intent, 3);
        } catch (RuntimeException failure) {
            file.delete(); downloadFile = null; downloadId = null;
            pinned.deliver(id, "error", 0, "");
        }
    }

    @Override protected void onActivityResult(int code, int result, android.content.Intent data) {
        super.onActivityResult(code, result, data);
        if (code == 2 && fileSelection != null) {
            fileSelection.onReceiveValue(result == RESULT_OK && data != null && data.getData() != null ? new android.net.Uri[]{data.getData()} : null);
            fileSelection = null;
        }
        if (code == 3 && downloadFile != null) {
            java.io.File file = downloadFile;
            String id = downloadId;
            downloadFile = null; downloadId = null;
            if (result != RESULT_OK || data == null || data.getData() == null) {
                file.delete(); pinned.deliver(id, "response", 200, "{\"cancelled\":true}"); return;
            }
            android.net.Uri target = data.getData();
            new Thread(() -> {
                try (java.io.InputStream input = new java.io.FileInputStream(file);
                     java.io.OutputStream output = getContentResolver().openOutputStream(target, "wt")) {
                    if (output == null) throw new java.io.IOException();
                    byte[] buffer = new byte[64 * 1024];
                    for (int count; (count = input.read(buffer)) != -1;) output.write(buffer, 0, count);
                    output.flush();
                    pinned.deliver(id, "response", 200, "{\"saved\":true}");
                } catch (Exception failure) { pinned.deliver(id, "error", 0, ""); }
                finally { file.delete(); }
            }, "leet-save-file").start();
        }
    }

    private boolean isWarehouse(String url) {
        return warehouseOrigin.equals(WarehouseIdentityProbe.httpsOrigin(url));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra("url");
        warehouseOrigin = WarehouseIdentityProbe.httpsOrigin(url);
        if (warehouseOrigin == null) {
            showError();
            return;
        }

        workspace = new WebView(this);
        String fingerprint = getIntent().getStringExtra("certificateFingerprint");
        if (fingerprint != null) {
            try {
                URI endpoint = new URI(url);
                String remoteOrigin = "https://" + endpoint.getRawAuthority();
                pinned = new PinnedWorkspace(workspace, remoteOrigin, fingerprint, getIntent().getStringExtra("route"),
                    getIntent().getBooleanExtra("administrator", false));
                workspace.addJavascriptInterface(pinned, "LeeTWarehouse");
                warehouseOrigin = WarehouseIdentityProbe.httpsOrigin(LOCAL_ORIGIN);
                url = LOCAL_ORIGIN + "/" + (endpoint.getRawFragment() == null ? "" : "#" + endpoint.getRawFragment());
            } catch (Exception error) {
                showError();
                return;
            }
        }
        WebSettings settings = workspace.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(workspace, false);
        workspace.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (pinned == null) return null;
                if (isWarehouse(request.getUrl().toString()) && "GET".equals(request.getMethod())) {
                    return pinned.resource(URI.create(request.getUrl().toString()));
                }
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
                    Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isWarehouse(request.getUrl().toString());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError();
                }
            }
        });
        workspace.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<android.net.Uri[]> callback, FileChooserParams params) {
                if (fileSelection != null) fileSelection.onReceiveValue(null);
                fileSelection = callback;
                try {
                    String[] types = params.getAcceptTypes();
                    android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(android.content.Intent.CATEGORY_OPENABLE).setType("*/*");
                    if (types.length > 0 && types[0].startsWith("image/")) intent.putExtra(android.content.Intent.EXTRA_MIME_TYPES, new String[]{"image/jpeg", "image/png"});
                    startActivityForResult(intent, 2);
                } catch (RuntimeException unavailable) {
                    fileSelection.onReceiveValue(null); fileSelection = null;
                    Toast.makeText(WarehouseActivity.this, "File picker unavailable / 无法选择文件", Toast.LENGTH_LONG).show();
                }
                return true;
            }
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (!isWarehouse(request.getOrigin().toString()) ||
                    !isWarehouse(workspace.getUrl()) ||
                    !Arrays.equals(request.getResources(), new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE}) ||
                    pendingCamera != null) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else {
                    pendingCamera = request;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
                }
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (request == pendingCamera) pendingCamera = null;
            }
        });
        setContentView(workspace);
        workspace.loadUrl(url);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != CAMERA_PERMISSION || pendingCamera == null) return;
        PermissionRequest request = pendingCamera;
        pendingCamera = null;
        if (results.length == 1 && results[0] == PackageManager.PERMISSION_GRANTED && isWarehouse(workspace.getUrl())) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            request.deny();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (workspace != null) workspace.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (workspace != null) workspace.onResume();
        if (printView != null) { printView.destroy(); printView = null; }
    }

    @Override
    protected void onDestroy() {
        if (fileSelection != null) fileSelection.onReceiveValue(null);
        fileSelection = null;
        if (downloadFile != null) downloadFile.delete();
        if (printView != null) printView.destroy();
        if (pendingCamera != null) pendingCamera.deny();
        pendingCamera = null;
        if (pinned != null) pinned.close();
        if (workspace != null) {
            workspace.removeJavascriptInterface("LeeTWarehouse");
            setContentView(new android.widget.FrameLayout(this));
            workspace.destroy();
        }
        super.onDestroy();
    }
}
