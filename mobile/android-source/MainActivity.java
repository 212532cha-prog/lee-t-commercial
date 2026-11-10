package my.leet.warehouse;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import java.net.CookieHandler;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(WarehouseWorkspacePlugin.class);
        super.onCreate(savedInstanceState);
        // The pinned transport owns its cookies. Do not let Capacitor also
        // attach cookies from the WebView to the same warehouse request.
        CookieHandler.setDefault(null);
    }
}
