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
        waitFor("!!document.querySelector(" + JSONObject.quote(selector) + ")");
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
        click("[data-page='" + target + "']");
        waitFor("document.querySelector('.app-layout')?.dataset.page===" + JSONObject.quote(target));
        waitFor("!document.querySelector('.main-panel').innerText.includes('Loading…')");
    }
    private JSONObject api(String path, String method, JSONObject body) throws Exception {
        js("window.qaResult=null;window.qaError=null;import('/native-transport.js').then(async m=>{let s=await(await m.warehouseFetch('/api/me')).json();let r=await m.warehouseFetch(" +
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
    private AdministratorStorage storage() throws Exception {
        return new AdministratorStorage(instrumentation.getTargetContext(), args.getString("origin"), args.getString("pin"));
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
            js("window.qaUpload=null;import('/native-transport.js').then(async m=>{let s=await(await m.warehouseFetch('/api/me')).json();let p=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));let r=await m.warehouseFetch('/api/products/"+args.getString("product")+"/photo',{method:'PUT',headers:{'Content-Type':'image/png','X-CSRF-Token':s.csrf},body:new Blob([p],{type:'image/png'})});window.qaUpload=r.status}).catch(e=>window.qaUpload=String(e))");
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

            // Android's save-document result writes the exact QR bytes into the chosen location.
            File output = new File(instrumentation.getTargetContext().getCacheDir(),"qa-qr.png");
            Intent result = new Intent().setData(Uri.fromFile(output));
            Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(new IntentFilter(Intent.ACTION_CREATE_DOCUMENT),new Instrumentation.ActivityResult(Activity.RESULT_OK,result),true);
            js("window.qaDownload=null;import('/native-transport.js').then(async m=>window.qaDownload=await m.warehouseDownload('/api/products/"+args.getString("product")+"/qr/download')).catch(e=>window.qaDownload={error:String(e)})");
            waitFor("window.qaDownload!==null");
            assertEquals("true",js("window.qaDownload.saved===true"));
            assertTrue(output.isFile()); byte[] png=Files.readAllBytes(output.toPath());
            assertEquals((byte)0x89,png[0]); assertEquals('P',png[1]);
            instrumentation.removeMonitor(monitor); output.delete();

            // A transient API failure is visible and recoverable, without clearing encrypted inventory.
            assertEquals(200,api("/api/test-control?token="+args.getString("control")+"&offline=1","GET",null).getInt("status"));
            waitFor("!!document.querySelector('#connection-state') && !document.querySelector('#connection-state').hidden");
            assertNotNull(storage().read().getJSONObject("inventory"));
            api("/api/test-control?token="+args.getString("control")+"&offline=0","GET",null);
            click("[data-action='reconnect']"); waitFor("document.querySelector('#connection-state').hidden");
            click("[data-action='sync-offline']"); waitFor("JSON.parse(LeeTWarehouse.offlineStatus()).state==='saved'");

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
