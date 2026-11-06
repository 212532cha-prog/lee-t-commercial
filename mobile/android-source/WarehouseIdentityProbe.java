package my.leet.warehouse;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

final class WarehouseIdentityProbe {
    private WarehouseIdentityProbe() {}

    static String httpsOrigin(String address) {
        if (address == null) return null;
        try {
            URI uri = new URI(address);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null ||
                uri.getRawUserInfo() != null || uri.getPort() == 0 || uri.getPort() > 65535) return null;
            int port = uri.getPort() < 0 ? 443 : uri.getPort();
            return uri.getHost().toLowerCase(Locale.ROOT) + ":" + port;
        } catch (URISyntaxException error) {
            return null;
        }
    }

    static final class Response {
        final int status;
        final String url;
        final String body;

        Response(int status, String url, String body) {
            this.status = status;
            this.url = url;
            this.body = body;
        }
    }

    static HttpsURLConnection open(URI uri, SSLSocketFactory sockets) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) uri.toURL().openConnection(java.net.Proxy.NO_PROXY);
        connection.setSSLSocketFactory(sockets);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        return connection;
    }

    static SSLSocketFactory socketFactory(String fingerprint) throws Exception {
        if (fingerprint == null || !fingerprint.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Invalid warehouse certificate fingerprint");
        }
        byte[] expected = new byte[32];
        for (int i = 0; i < expected.length; i++) {
            expected[i] = (byte) Integer.parseInt(fingerprint.substring(i * 2, i * 2 + 2), 16);
        }
        X509TrustManager pinned = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("Client certificate trust is unavailable");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("No warehouse certificate");
                X509Certificate leaf = chain[0];
                leaf.checkValidity();
                try {
                    byte[] actual = MessageDigest.getInstance("SHA-256").digest(leaf.getEncoded());
                    if (leaf.getBasicConstraints() >= 0 || !MessageDigest.isEqual(expected, actual)) {
                        throw new CertificateException("Warehouse certificate does not match the pairing code");
                    }
                } catch (java.security.NoSuchAlgorithmException error) {
                    throw new CertificateException(error);
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{pinned}, null);
        return context.getSocketFactory();
    }

    static Response verify(String address, String fingerprint) throws Exception {
        if (httpsOrigin(address) == null || fingerprint == null ||
            !fingerprint.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Invalid warehouse identity");
        }
        URI uri = new URI(address);
        if (!"/api/commercial/server-identity".equals(uri.getRawPath()) ||
            uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("Invalid warehouse identity endpoint");
        }
        HttpsURLConnection connection = open(uri, socketFactory(fingerprint));
        try {
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            String body = null;
            if (status == 200) {
                try (InputStream input = connection.getInputStream()) {
                    ByteArrayOutputStream data = new ByteArrayOutputStream();
                    byte[] buffer = new byte[1024];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (data.size() + count > 4096) throw new IllegalStateException("Warehouse identity response is too large");
                        data.write(buffer, 0, count);
                    }
                    body = new String(data.toByteArray(), StandardCharsets.UTF_8);
                }
            }
            return new Response(status, connection.getURL().toExternalForm(), body);
        } finally {
            connection.disconnect();
        }
    }
}
