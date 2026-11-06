package my.leet.warehouse;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(WarehouseWorkspacePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
