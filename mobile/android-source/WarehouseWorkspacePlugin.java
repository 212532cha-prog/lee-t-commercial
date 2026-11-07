package my.leet.warehouse;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "WarehouseWorkspace", permissions = {
    @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
})
public class WarehouseWorkspacePlugin extends Plugin {
    @PluginMethod
    public void ensureCamera(PluginCall call) {
        PermissionState state = getPermissionState("camera");
        if (state == PermissionState.PROMPT || state == PermissionState.PROMPT_WITH_RATIONALE) {
            requestPermissionForAlias("camera", call, "cameraResult");
        } else {
            cameraResult(call);
        }
    }

    @PermissionCallback
    private void cameraResult(PluginCall call) {
        call.resolve(new JSObject().put("granted", getPermissionState("camera") == PermissionState.GRANTED));
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Uri application = Uri.fromParts("package", getContext().getPackageName(), null);
            getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, application));
            call.resolve();
        } catch (RuntimeException failure) {
            call.reject("App settings are unavailable");
        }
    }

    @PluginMethod
    public void discover(PluginCall call) {
        String serverId = call.getString("serverId");
        Integer port = call.getInt("port");
        if (serverId == null || !serverId.matches("[a-f0-9-]{36}") || port == null || port < 1 || port > 65535) {
            call.reject("Invalid warehouse discovery identity");
            return;
        }
        new WarehouseDiscovery(getContext(), serverId, port, addresses -> {
            JSArray result = new JSArray();
            for (String address : addresses) result.put(address);
            call.resolve(new JSObject().put("addresses", result));
        }).start();
    }

    @PluginMethod
    public void verifyIdentity(PluginCall call) {
        try {
            WarehouseIdentityProbe.Response response =
                WarehouseIdentityProbe.verify(call.getString("url"), call.getString("certificateFingerprint"), call.getString("route"));
            JSObject result = new JSObject().put("status", response.status).put("url", response.url);
            if (response.body != null) result.put("data", new JSObject(response.body));
            call.resolve(result);
        } catch (Exception error) {
            for (Throwable cause = error; cause != null; cause = cause.getCause()) {
                if (cause instanceof WarehouseIdentityProbe.IdentityMismatch) {
                    call.reject("Warehouse certificate identity changed", "PAIRING_CERTIFICATE_MISMATCH");
                    return;
                }
            }
            call.reject("Could not verify the warehouse certificate");
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (WarehouseIdentityProbe.httpsOrigin(url) == null) {
            call.reject("Invalid warehouse URL");
            return;
        }
        try {
            getActivity().startActivity(new Intent(getActivity(), WarehouseActivity.class).putExtra("url", url)
                .putExtra("certificateFingerprint", call.getString("certificateFingerprint"))
                .putExtra("route", call.getString("route")));
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Could not open the warehouse workspace");
        }
    }
}
