package my.leet.warehouse;

import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WarehouseWorkspace")
public class WarehouseWorkspacePlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (WarehouseActivity.httpsOrigin(url) == null) {
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
