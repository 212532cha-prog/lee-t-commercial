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
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.util.Arrays;

public class WarehouseActivity extends Activity {
    private static final int CAMERA_PERMISSION = 1;
    private WebView workspace;
    private String warehouseOrigin;
    private PermissionRequest pendingCamera;

    private boolean isWarehouse(String url) {
        return warehouseOrigin.equals(WarehouseIdentityProbe.httpsOrigin(url));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra("url");
        warehouseOrigin = WarehouseIdentityProbe.httpsOrigin(url);
        if (warehouseOrigin == null) {
            finish();
            return;
        }

        // Keep the remote page in its own WebView without the Capacitor native bridge.
        workspace = new WebView(this);
        WebSettings settings = workspace.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(workspace, false);
        workspace.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isWarehouse(request.getUrl().toString());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(WarehouseActivity.this, "Could not load the warehouse. Check Wi-Fi and HTTPS trust.", Toast.LENGTH_LONG).show();
                    finish();
                }
            }
        });
        workspace.setWebChromeClient(new WebChromeClient() {
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
    }

    @Override
    protected void onDestroy() {
        if (pendingCamera != null) pendingCamera.deny();
        pendingCamera = null;
        if (workspace != null) {
            setContentView(new android.widget.FrameLayout(this));
            workspace.destroy();
        }
        super.onDestroy();
    }
}
