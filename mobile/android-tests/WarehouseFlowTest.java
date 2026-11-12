package my.leet.warehouse;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.json.JSONObject;
import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Real bundled HTML -> JavascriptInterface -> pinned TLS -> PostgreSQL. No mocked API responses. */
public class WarehouseFlowTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final Bundle args = InstrumentationRegistry.getArguments();
    private WarehouseActivity activity;
    private WebView web;

    private WebView findWeb(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) for (int i=0; i<((ViewGroup)view).getChildCount(); i++) {
            WebView result = findWeb(((ViewGroup)view).getChildAt(i)); if (result != null) return result;
        }
        return null;
    }
    private void open(boolean admin) throws Exception {
        close();
        Intent intent = new Intent(instrumentation.getTargetContext(), WarehouseActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("url", args.getString("origin") + "/")
            .putExtra("certificateFingerprint", args.getString("pin")).putExtra("route", "10.0.2.2")
            .putExtra("administrator", admin);
        activity = (WarehouseActivity) instrumentation.startActivitySync(intent);
        instrumentation.runOnMainSync(() -> web = findWeb(activity.getWindow().getDecorView()));
        assertNotNull("Workspace must open rather than silently returning to launcher", web);
        waitFor("typeof window.leetNativeReceive==='function' && !!document.querySelector('#language')");
    }
    private void close() {
        if (activity != null) instrumentation.runOnMainSync(() -> activity.finish());
        activity = null; web = null; instrumentation.waitForIdleSync();
    }
    private String js(String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> web.evaluateJavascript(script, result -> { value.set(result); latch.countDown(); }));
        assertTrue("WebView did not answer", latch.await(5, TimeUnit.SECONDS));
        return value.get();
    }
    private void waitFor(String expression) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 25000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if ("true".equals(js("Boolean(" + expression + ")"))) return;
            SystemClock.sleep(100);
        }
        fail("Timed out: " + expression + "\n" + js("document.body.innerText"));
    }
    private void click(String selector) throws Exception {
        waitFor("!!document.querySelector(" + JSONObject.quote(selector) + ") && !document.querySelector(" + JSONObject.quote(selector) + ").disabled");
        js("document.querySelector(" + JSONObject.quote(selector) + ").click()");
    }
    private void input(String selector, String value) throws Exception {
        js("document.querySelector(" + JSONObject.quote(selector) + ").value=" + JSONObject.quote(value));
    }
    private void login(String user) throws Exception {
        waitFor("!!document.querySelector('#login')");
        input("#username", user); input("#password", args.getString("password"));
        js("document.querySelector('#login').requestSubmit()");
        waitFor("!!document.querySelector('.workspace') && !!document.querySelector('.main-panel h2')");
    }
    private void nav(String target) throws Exception {
        String button = ".bottom button[data-page='" + target + "']";
        if (!"true".equals(js("!!document.querySelector(" + JSONObject.quote(button) + ")"))) {
            if ("true".equals(js("getComputedStyle(document.querySelector('.sidebar')).display==='none'"))) click("[data-action=menu]");
            button = ".sidebar button[data-page='" + target + "']";
        }
        click(button);
        waitFor("document.querySelector('.app-layout')?.dataset.page===" + JSONObject.quote(target));
        waitFor("!document.querySelector('.main-panel').innerText.includes('Loading…')");
    }
    private JSONObject api(String path, String method, JSONObject body) throws Exception {
        js("window.qaResult=null;window.qaError=null;import('https://appassets.androidplatform.net/native-transport.js').then(async m=>{let s=await(await m.warehouseFetch('/api/me')).json();let r=await m.warehouseFetch(" +
            JSONObject.quote(path) + ",{method:"+JSONObject.quote(method)+",headers:{'X-CSRF-Token':s.csrf,'Content-Type':'application/json'},body:"+
            (body == null ? "undefined" : JSONObject.quote(body.toString())) + "});window.qaResult={status:r.status,body:await r.json()}}).catch(e=>window.qaError=String(e))");
        waitFor("window.qaResult!==null || window.qaError!==null");
        assertEquals("null",js("window.qaError"));
        return new JSONObject(js("JSON.stringify(window.qaResult)").equals("null") ? "{}" : new org.json.JSONTokener(js("JSON.stringify(window.qaResult)")).nextValue().toString());
    }
    private void scan(String selector) throws Exception {
        input(selector,args.getString("token"));
        js("document.querySelector("+JSONObject.quote(selector)+").form.requestSubmit()");
    }
    private IntentFilter documentIntent(String action) throws Exception {
        IntentFilter filter = new IntentFilter(action);
        filter.addCategory(Intent.CATEGORY_OPENABLE);
        filter.addDataType("*/*");
        return filter;
    }
    private File saveFile(String path, String name) throws Exception {
        File output = new File(instrumentation.getTargetContext().getCacheDir(), name);
        Intent result = new Intent().setData(Uri.fromFile(output));
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(documentIntent(Intent.ACTION_CREATE_DOCUMENT), new Instrumentation.ActivityResult(Activity.RESULT_OK,result),true);
        try {
            js("window.qaDownload=null;import('https://appassets.androidplatform.net/native-transport.js').then(async m=>window.qaDownload=await m.warehouseDownload(" + JSONObject.quote(path) + ")).catch(e=>window.qaDownload={error:String(e)})");
            waitFor("window.qaDownload!==null");
            assertEquals("File must be saved, not silently discarded", "true", js("window.qaDownload.saved===true"));
            assertTrue(output.isFile()); assertTrue(output.length()>0);
            return output;
        } finally { instrumentation.removeMonitor(monitor); }
    }
    private void tap(String selector) throws Exception {
        js("document.querySelector(" + JSONObject.quote(selector) + ").scrollIntoView({block:'center'})");
        JSONObject point = new JSONObject(js("(()=>{let r=document.querySelector(" + JSONObject.quote(selector) + ").getBoundingClientRect();return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()"));
        final float[] position = new float[3];
        instrumentation.runOnMainSync(() -> { int[] location = new int[2]; web.getLocationOnScreen(location); position[0]=location[0];position[1]=location[1];position[2]=web.getScale(); });
        float x=position[0]+(float)point.getDouble("x")*position[2], y=position[1]+(float)point.getDouble("y")*position[2];
        long now=SystemClock.uptimeMillis();
        android.view.MotionEvent down=android.view.MotionEvent.obtain(now,now,android.view.MotionEvent.ACTION_DOWN,x,y,0);
        android.view.MotionEvent up=android.view.MotionEvent.obtain(now,now+50,android.view.MotionEvent.ACTION_UP,x,y,0);
        try { instrumentation.sendPointerSync(down); instrumentation.sendPointerSync(up); }
        finally { down.recycle();up.recycle(); }
    }
    private void chooseFile(String selector, File file) throws Exception {
        Uri uri = androidx.core.content.FileProvider.getUriForFile(instrumentation.getTargetContext(), "my.leet.warehouse.fileprovider", file);
        Intent result = new Intent().setData(uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(documentIntent(Intent.ACTION_OPEN_DOCUMENT),new Instrumentation.ActivityResult(Activity.RESULT_OK,result),true);
        try {
            tap(selector);
            waitFor("document.querySelector(" + JSONObject.quote(selector) + ").files.length===1");
        } finally { instrumentation.removeMonitor(monitor); }
    }
    private AdministratorStorage storage() throws Exception {
        return new AdministratorStorage(instrumentation.getTargetContext(), args.getString("origin"), args.getString("pin"));
    }
    @Test public void secureStorageRejectsExpiryCorruptionAndMismatchedSessions() throws Exception {
        AdministratorStorage saved = storage();
        saved.clear();
        for (String invalid : new String[]{"http://warehouse.example:13443", args.getString("origin") + "/", args.getString("origin") + "?x=1", "https://user@warehouse.example:13443"}) {
            try { new AdministratorStorage(instrumentation.getTargetContext(), invalid, args.getString("pin")); fail("Invalid storage identity accepted"); }
            catch (IllegalArgumentException expected) {}
        }
        String token = "a".repeat(43);
        JSONObject record = AdministratorStorage.newSession(token);
        saved.save(record);
        saved.saveInventory(token, new JSONObject().put("synchronizedAt", "2026-11-12T07:00:00Z").put("products", new org.json.JSONArray()));
        assertNotNull(saved.read().getJSONObject("inventory"));
        try { saved.saveInventory("b".repeat(43), new JSONObject()); fail("Wrong session wrote offline inventory"); }
        catch (IllegalStateException expected) {}
        record.put("createdAt", System.currentTimeMillis() - 8L * 24 * 60 * 60 * 1000);
        saved.save(record); assertNull(saved.read());
        try { saved.saveInventory(token, new JSONObject()); fail("Expired session reported sync success"); }
        catch (IllegalStateException expected) {}
        record = AdministratorStorage.newSession(token); saved.save(record);
        java.lang.reflect.Field field = AdministratorStorage.class.getDeclaredField("file"); field.setAccessible(true);
        File file = ((android.util.AtomicFile) field.get(saved)).getBaseFile();
        byte[] encrypted = Files.readAllBytes(file.toPath());
        assertFalse(new String(encrypted, java.nio.charset.StandardCharsets.UTF_8).contains(token));
        encrypted[encrypted.length - 1] ^= 1; Files.write(file.toPath(), encrypted);
        assertNull("Tampered ciphertext must never be accepted", saved.read());
        saved.clear();
    }

    @Test public void packagedAdministratorEmployeeAndBusinessFlows() throws Exception {
        try {
            storage().clear();
            // Regression: administrator logging in through the old general/employee entry must still save securely.
            open(false); login("CTL LEE");
            waitFor("JSON.parse(LeeTWarehouse.offlineStatus()).state==='saved'");
            JSONObject record = storage().read();
            assertNotNull(record); assertEquals(1,record.getJSONObject("inventory").getJSONArray("products").length());
            assertEquals("Phone bolt",record.getJSONObject("inventory").getJSONArray("products").getJSONObject(0).getString("name"));
            // Inventory is isolated by certificate and origin.
            assertNull(new AdministratorStorage(instrumentation.getTargetContext(),args.getString("origin"),"0".repeat(64)).read());

            nav("products"); click("[data-catalog='detail']"); click("[data-catalog='edit']");
            input("#product-name","Phone bolt updated");
            js("document.querySelector('#catalog-product').requestSubmit()");
            waitFor("!!document.querySelector('[data-catalog=edit]') && document.querySelector('.main-panel').innerText.includes('Phone bolt updated')");
            assertEquals("PATCH product edit",200,api("/api/products/"+args.getString("product"),"GET",null).getInt("status"));
            // Actual native binary upload and protected image reads, not a fetch mock.
            js("window.qaUpload=null;import('https://appassets.androidplatform.net/native-transport.js').then(async m=>{let s=await(await m.warehouseFetch('/api/me')).json();let p=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQWdiFFTEMLQkAoChTwXaTP6IAAAAASUVORK5CYII='),c=>c.charCodeAt(0));let r=await m.warehouseFetch('/api/products/"+args.getString("product")+"/photo',{method:'PUT',headers:{'Content-Type':'image/png','X-CSRF-Token':s.csrf},body:new Blob([p],{type:'image/png'})});window.qaUpload=r.status}).catch(e=>window.qaUpload=String(e))");
            waitFor("window.qaUpload!==null"); assertEquals("200",js("window.qaUpload"));
            nav("products"); click("[data-catalog='detail']");
            waitFor("document.querySelector('.product-image')?.naturalWidth>0 && document.querySelector('.qr-image')?.naturalWidth>0");

            nav("inbound"); scan("#scan-token");
            waitFor("!!document.querySelector('table tbody strong')"); click("[data-stock='commit']");
            waitFor("document.querySelector('.main-panel').innerText.includes('Committed')");
            nav("outbound"); scan("#scan-token");
            waitFor("!!document.querySelector('table tbody strong')"); click("[data-stock='commit']");
            waitFor("document.querySelector('.main-panel').innerText.includes('Committed')");
            assertEquals("0",api("/api/products/"+args.getString("product"),"GET",null).getJSONObject("body").getJSONObject("product").getString("quantity"));

            for(String target:new String[]{"home","costs","exports","team","backups","profile","count","reports"}) {
                nav(target);
                assertEquals("Module "+target+" must not show request failure", "false",js("/Operation failed|Cannot reach|Unsupported/.test(document.querySelector('.main-panel').innerText)"));
            }
            nav("profile"); input("#admin-profile input[name=realName]","Phone Administrator");
            js("document.querySelector('#admin-profile').requestSubmit()");
            waitFor("document.querySelector('.workspace h1')?.innerText==='Phone Administrator'");

            // Android save-document, export generation, file picker, streamed upload and server archive verification.
            File output = saveFile("/api/products/"+args.getString("product")+"/qr/download", "qa-qr.svg");
            String svg = new String(Files.readAllBytes(output.toPath()), java.nio.charset.StandardCharsets.UTF_8);
            assertTrue("Download must contain the real vector QR", svg.contains("<svg") && svg.contains("<path")); output.delete();
            nav("exports");
            waitFor("!!document.querySelector('#admin-export') && !document.querySelector('#admin-export button').disabled");
            js("document.querySelector('#admin-export').requestSubmit()");
            waitFor("!!document.querySelector('a[href^=\"/api/exports/\"]')");
            String exportPath = (String)new org.json.JSONTokener(js("document.querySelector('a[href^=\"/api/exports/\"]').getAttribute('href')")).nextValue();
            File workbook = saveFile(exportPath,"qa-inventory.xlsx");
            try (java.util.zip.ZipFile zip = new java.util.zip.ZipFile(workbook)) {
                assertNotNull(zip.getEntry("xl/worksheets/sheet1.xml"));
            }
            workbook.delete();
            nav("backups");
            File archive = saveFile("/api/backups/download-full","qa-full.whb");
            chooseFile("#backup-upload input[type=file]", archive);
            js("document.querySelector('#backup-upload').requestSubmit()");
            waitFor("!!document.querySelector('[data-backup=restore-upload]')");
            click("[data-backup=clear]"); waitFor("!document.querySelector('[data-backup=restore-upload]')");
            archive.delete();

            // A transient API failure is visible and recoverable, without clearing encrypted inventory.
            assertEquals(200,api("/api/test-control?token="+args.getString("control")+"&offline=1","GET",null).getInt("status"));
            waitFor("!!document.querySelector('#connection-state') && !document.querySelector('#connection-state').hidden");
            assertNotNull(storage().read().getJSONObject("inventory"));
            api("/api/test-control?token="+args.getString("control")+"&offline=0","GET",null);
            click("[data-action='reconnect']"); waitFor("document.querySelector('#connection-state').hidden");
            js("window.qaSyncSaved=false;window.addEventListener('leet-offline-status',e=>{if(e.detail.state==='saved')window.qaSyncSaved=true})");
            click("[data-action='sync-offline']"); waitFor("window.qaSyncSaved && JSON.parse(LeeTWarehouse.offlineStatus()).state==='saved'");

            // Reopening the administrator entry restores the encrypted session, not just a WebView cookie.
            open(true); waitFor("document.querySelector('.workspace h1')?.innerText==='Phone Administrator'");
            JSONObject task=api("/api/count/tasks","POST",new JSONObject().put("title","Phone count").put("scope","all")).getJSONObject("body");
            JSONObject invite=api("/api/test-control?token="+args.getString("control")+"&invitation=1","GET",null).getJSONObject("body");
            // General employee entry never inherits administrator credentials.
            open(false); waitFor("!!document.querySelector('#login')");
            assertEquals("true",js("document.querySelector('.login h1').innerText==='Employee sign-in'"));
            JSONObject employeeLogin=api("/api/auth/login","POST",new JSONObject().put("username","phone employee").put("password",args.getString("password")).put("invitation",invite));
            assertEquals(200,employeeLogin.getInt("status"));
            assertEquals(403,api("/api/products/offline-inventory","GET",null).getInt("status"));
            // Reload the local UI to pick up the real server-authorized employee session.
            instrumentation.runOnMainSync(()->web.reload()); waitFor("!!document.querySelector('.workspace')");
            nav("count"); click("[data-count='accept']");
            waitFor("document.querySelector('.main-panel').innerText.includes('Connected. Ready to count.')");
            waitFor("document.querySelector('.count-photo')?.naturalWidth>0");
            scan("#count-token"); waitFor("document.querySelector('[data-count-quantity]')?.value==='1'");
            click("[data-count='submit']"); waitFor("document.querySelector('.main-panel').innerText.includes('Report submitted') || document.querySelector('#message').innerText.includes('Report submitted')");
            assertEquals("Count must not alter live stock", "0",api("/api/products/"+args.getString("product"),"GET",null).getJSONObject("body").getJSONObject("product").getString("quantity"));
            assertEquals("true",js("document.querySelectorAll('[data-page=team],[data-page=costs],[data-page=backups],[data-page=exports]').length===0"));
            assertNotNull("Employee sign-in must not erase separately saved administrator access",storage().read());
            assertNotNull(task.getString("id"));
            open(true); waitFor("!!document.querySelector('.workspace')");
            nav("reports"); waitFor("!!document.querySelector('[data-count=report]')");
            click("[data-count=report]"); waitFor("document.querySelector('.main-panel').innerText.includes('Phone count')");
            click("[data-action=logout]"); waitFor("!!document.querySelector('#login')");
            assertNull("Explicit administrator logout clears secure session and inventory",storage().read());
            open(true); waitFor("!!document.querySelector('#login')");
            assertEquals("true",js("document.querySelector('.login h1').innerText==='Administrator sign-in'"));
            for(String language:new String[]{"zh","ms","en"}) {
                js("document.querySelector('#language').value='"+language+"';document.querySelector('#language').dispatchEvent(new Event('change'))");
                assertEquals("true",js("document.documentElement.scrollWidth<=innerWidth"));
            }
        } finally { close(); }
    }
}
