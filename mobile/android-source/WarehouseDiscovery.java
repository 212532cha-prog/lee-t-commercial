package my.leet.warehouse;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.function.Consumer;

final class WarehouseDiscovery implements NsdManager.DiscoveryListener {
    private final NsdManager manager;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final String serverId;
    private final int port;
    private final Consumer<Set<String>> complete;
    private final ArrayDeque<NsdServiceInfo> pending = new ArrayDeque<>();
    private final Set<String> addresses = new LinkedHashSet<>();
    private boolean resolving;
    private boolean finished;
    private final Runnable timeout = this::finish;

    WarehouseDiscovery(Context context, String serverId, int port, Consumer<Set<String>> complete) {
        manager = context.getSystemService(NsdManager.class);
        this.serverId = serverId;
        this.port = port;
        this.complete = complete;
    }

    void start() {
        handler.post(() -> {
            try {
                manager.discoverServices("_leet-warehouse._tcp.", NsdManager.PROTOCOL_DNS_SD, this);
                handler.postDelayed(timeout, 4000);
            } catch (RuntimeException error) {
                finish();
            }
        });
    }

    private void finish() {
        if (finished) return;
        finished = true;
        handler.removeCallbacks(timeout);
        pending.clear();
        try { manager.stopServiceDiscovery(this); } catch (RuntimeException ignored) {}
        complete.accept(addresses);
    }

    @Override public void onDiscoveryStarted(String type) {}
    @Override public void onDiscoveryStopped(String type) { handler.post(this::finish); }
    @Override public void onStartDiscoveryFailed(String type, int code) { handler.post(this::finish); }
    @Override public void onStopDiscoveryFailed(String type, int code) { handler.post(this::finish); }
    @Override public void onServiceLost(NsdServiceInfo service) {}

    @Override
    public void onServiceFound(NsdServiceInfo service) {
        handler.post(() -> {
            if (finished || pending.size() >= 8 || !("Lee T " + serverId).equals(service.getServiceName())) return;
            pending.add(service);
            resolveNext();
        });
    }

    private void resolveNext() {
        if (finished || resolving || pending.isEmpty()) return;
        resolving = true;
        try {
            manager.resolveService(pending.remove(), new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo service, int code) {
                    handler.post(() -> resolved(null));
                }

                @Override public void onServiceResolved(NsdServiceInfo service) {
                    handler.post(() -> resolved(service));
                }
            });
        } catch (RuntimeException error) {
            resolved(null);
        }
    }

    private void resolved(NsdServiceInfo service) {
        if (finished) return;
        resolving = false;
        if (service != null && service.getPort() == port && serverId.equals(attribute(service, "id")) &&
            "1".equals(attribute(service, "v"))) {
            Iterable<InetAddress> hosts = Build.VERSION.SDK_INT >= 34 ?
                service.getHostAddresses() : Collections.singletonList(service.getHost());
            for (InetAddress host : hosts) {
                if (host instanceof Inet4Address && host.isSiteLocalAddress()) addresses.add(host.getHostAddress());
                if (addresses.size() == 8) break;
            }
        }
        if (addresses.size() == 8) finish();
        else resolveNext();
    }

    private static String attribute(NsdServiceInfo service, String key) {
        byte[] value = service.getAttributes().get(key);
        return value == null ? "" : new String(value, StandardCharsets.UTF_8);
    }
}
