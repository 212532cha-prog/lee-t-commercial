package my.leet.warehouse;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class AdministratorStorage {
    private static final long LIFETIME = 7L * 24 * 60 * 60 * 1000;
    private static final String KEY_ALIAS = "leet-warehouse-administrator-v1";
    private static final int NONCE_BYTES = 12;
    private final AtomicFile file;
    private final byte[] identity;

    AdministratorStorage(Context context, String origin, String fingerprint) throws Exception {
        if (origin == null || !origin.equals(WarehouseIdentityProbe.httpsOrigin(origin)) ||
                fingerprint == null || !fingerprint.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("Invalid administrator warehouse identity");
        }
        identity = (origin + "\n" + fingerprint).getBytes(StandardCharsets.UTF_8);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity);
        StringBuilder id = new StringBuilder();
        for (byte value : digest) id.append(String.format(Locale.ROOT, "%02x", value & 255));
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "administrator-" + id));
    }

    private static synchronized SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(KEY_ALIAS, null);
        if (existing != null || !create) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build());
        return generator.generateKey();
    }

    static JSONObject newSession(String token) throws Exception {
        return new JSONObject().put("token", token).put("createdAt", System.currentTimeMillis());
    }

    JSONObject read() {
        synchronized (AdministratorStorage.class) { return readLocked(); }
    }

    private JSONObject readLocked() {
        try {
            byte[] encrypted = file.readFully();
            if (encrypted.length <= NONCE_BYTES || encrypted.length > 1_600_000) throw new IllegalStateException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, encrypted, 0, NONCE_BYTES));
            cipher.updateAAD(identity);
            JSONObject record = new JSONObject(new String(cipher.doFinal(encrypted, NONCE_BYTES,
                encrypted.length - NONCE_BYTES), StandardCharsets.UTF_8));
            long age = System.currentTimeMillis() - record.getLong("createdAt");
            if (age < 0 || age >= LIFETIME || !record.getString("token").matches("[A-Za-z0-9_-]{43}")) {
                throw new IllegalStateException();
            }
            return record;
        } catch (Exception ignored) {
            clear();
            return null;
        }
    }

    void save(JSONObject record) throws Exception {
        synchronized (AdministratorStorage.class) { saveLocked(record); }
    }

    void saveInventory(String token, JSONObject inventory) throws Exception {
        synchronized (AdministratorStorage.class) {
            JSONObject record = readLocked();
            if (record != null && record.getString("token").equals(token)) {
                record.put("inventory", inventory);
                saveLocked(record);
            }
        }
    }

    private void saveLocked(JSONObject record) throws Exception {
        byte[] plain = record.toString().getBytes(StandardCharsets.UTF_8);
        if (plain.length > 1_550_000) throw new IllegalArgumentException("Administrator data too large");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(identity);
        byte[] nonce = cipher.getIV();
        if (nonce.length != NONCE_BYTES) throw new IllegalStateException();
        byte[] encrypted = cipher.doFinal(plain);
        byte[] contents = Arrays.copyOf(nonce, nonce.length + encrypted.length);
        System.arraycopy(encrypted, 0, contents, nonce.length, encrypted.length);
        FileOutputStream output = file.startWrite();
        try {
            output.write(contents);
            file.finishWrite(output);
        } catch (Exception failure) {
            file.failWrite(output);
            throw failure;
        }
    }

    void clear() {
        synchronized (AdministratorStorage.class) { file.delete(); }
    }
}
