package my.leet.warehouse;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WarehouseWorkspace")
public class WarehouseWorkspacePlugin extends Plugin {
    @PluginMethod
    public void verifyIdentity(PluginCall call) {
        try {
            WarehouseIdentityProbe.Response response =
                WarehouseIdentityProbe.verify(call.getString("url"), call.getString("certificateFingerprint"));
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
            getActivity().startActivity(new Intent(getActivity(), WarehouseActivity.class).putExtra("url", url));
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Could not open the warehouse workspace");
        }
    }
}
