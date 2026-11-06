package my.leet.warehouse;

import android.content.Intent;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WarehouseWorkspace")
public class WarehouseWorkspacePlugin extends Plugin {
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
