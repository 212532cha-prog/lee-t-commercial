import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {testPool} from './helpers/database.mjs';
import {launchBrowser} from './helpers/browser.mjs';
import {migrate} from '../src/db/database.mjs';
import {AuthService} from '../src/auth/service.mjs';
import {createAuthServer} from '../src/auth/http.mjs';
import {CatalogService,UNASSIGNED} from '../src/catalog/service.mjs';
import {PhotoStore} from '../src/catalog/files.mjs';
import {createCatalogRoutes} from '../src/catalog/routes.mjs';
import {workbookWithRows,productRow} from "./helpers/product-workbook.mjs";
import {StockService} from '../src/stock/service.mjs';
import {HistoryCleanup} from '../src/stock/cleanup.mjs';
import {createStockRoutes} from '../src/stock/routes.mjs';
import {CountService} from '../src/count/service.mjs';
import {createCountRoutes} from '../src/count/routes.mjs';
import {BackupService} from '../src/backup/service.mjs';
import {createBackupRoutes} from '../src/backup/routes.mjs';
import {DashboardService} from '../src/dashboard/service.mjs';
import {ProfileService} from '../src/profile/service.mjs';
import {ExportService} from '../src/export/service.mjs';
import {createApplicationRoutes} from '../src/dashboard/routes.mjs';
let pool,auth,catalog,photos,stock,count,backup,dashboard,profile,exporter,server,proxy,base,browserFixture,root,password,p,q,contexts=[],errors=[];
before(async()=>{const db=await testPool();pool=db.pool;console.log('Browser SQL tests: '+db.engine);await migrate(pool);auth=new AuthService(pool);root=await mkdtemp(join(tmpdir(),'warehouse-browser-'));server=createAuthServer({auth,publicOrigin:'https://warehouse.test',catalogRoutes:c=>createCatalogRoutes({auth,catalog,photos,exporter})(c),stockRoutes:c=>createStockRoutes({stock,cleanup:new HistoryCleanup(pool,auth,backup)})(c),countRoutes:c=>createCountRoutes({count,auth,photos})(c),backupRoutes:c=>createBackupRoutes({backup})(c),applicationRoutes:c=>createApplicationRoutes({auth,dashboard,profile,exports:exporter})(c)});server.listen(0,'127.0.0.1');await once(server,'listening');
 // Localhost UI-only transport adapter, never a production HTTPS/certificate acceptance substitute.
 // Cookies/CSRF/CSP stay intact. Independent TLS tests enforce real certificate trust/hostname validation.
 proxy=createServer((req,res)=>{const headers={...req.headers};if(headers.origin===base)headers.origin='https://warehouse.test';const upstream=request({host:'127.0.0.1',port:server.address().port,path:req.url,method:req.method,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);res.on('close',()=>r.destroy());});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);});proxy.listen(0,'127.0.0.1');await once(proxy,'listening');base=`http://localhost:${proxy.address().port}`;browserFixture=await launchBrowser();console.log('Actual browser: '+browserFixture.browser.version());});
afterEach(async()=>{for(const c of contexts)await c.close();contexts=[];assert.deepEqual(errors,[]);});
after(async()=>{await exporter?.tail;if(browserFixture){await browserFixture.browser.close();await browserFixture.cleanup();}for(const s of [proxy,server])if(s){s.closeAllConnections();await new Promise(r=>s.close(r));}if(pool)await pool.end();if(root)await rm(root,{recursive:true,force:true});});
beforeEach(async()=>{errors=[];await exporter?.tail;await pool.query('TRUNCATE users,categories,products,stock_requests,backup_runs,backup_uploads CASCADE');await pool.query('UPDATE system_settings SET maintenance=false,admin_backup_required=false');await pool.query('UPDATE backup_config SET warning=NULL,path1=NULL,path2=NULL');await rm(root,{recursive:true,force:true});const data=join(root,'data');await mkdir(data,{recursive:true});password=randomUUID();await auth.bootstrap(password);await auth.createEmployee({username:'staff',realName:'员工 Staff',password});const seed=new CatalogService(pool),category=await seed.addMaster('categories',{name:'Fixture Category'}),input={name:'Fixture Bolt',categoryId:category.id,locationId:UNASSIGNED,individualCost:'1.25',minimumStock:5,supplierIds:[]};p=await seed.create(input);q=await seed.create({...input,name:'Fixture Nut'});catalog=new CatalogService(pool,auth);photos=new PhotoStore(pool,join(data,'product-photos'),auth);stock=new StockService(pool,auth);count=new CountService(pool,auth);backup=new BackupService(pool,auth,data);dashboard=new DashboardService(pool,auth);profile=new ProfileService(pool,auth,data);exporter=new ExportService(pool,auth,data);});
async function login(name='CTL LEE',mobile=false,language='zh'){const context=await browserFixture.browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000}});contexts.push(context);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);if(language!=='en')await page.locator('#language').selectOption(language);await page.locator('#username').fill(name);await page.locator('#password').fill(password);await page.locator('#login button').click();await page.locator('.workspace').waitFor();await page.locator('.main-panel h2').waitFor();return page;}
async function nav(page,target){const bottom=page.locator(`.bottom [data-page="${target}"]`);if(await bottom.isVisible())return bottom.click();const side=page.locator(`.sidebar [data-page="${target}"]`);if(!await side.isVisible())await page.locator('[data-action="menu"]').click();await side.click();}
async function scan(page,token,n){for(let i=1;i<=n;i++){await page.locator('#scan-token').fill(token);await page.locator('#scan-token').press('Enter');await page.locator('table tbody strong').filter({hasText:new RegExp('^'+i+'$')}).waitFor();}}
async function publish(page,title){await nav(page,'count');await page.locator('[data-count="publish"]').click();await page.locator('#count-publish input[name="title"]').fill(title);await page.locator('#count-publish button').click();await page.getByText(title,{exact:false}).first().waitFor();}
async function screenshot(page,name){await page.evaluate(()=>globalThis.document.fonts.ready);if(process.env.BROWSER_QA_DIR){await mkdir(process.env.BROWSER_QA_DIR,{recursive:true});await page.screenshot({path:join(process.env.BROWSER_QA_DIR,name+'.png'),fullPage:true});}assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth),true);}
test('first visit uses English and shows the LEE T brand and Administrator display name',async()=>{
 const page=await login('CTL LEE',false,'en');
 assert.equal(await page.locator('html').getAttribute('lang'),'en');
 assert.equal(await page.locator('#language').inputValue(),'en');
 assert.match(await page.title(),/^LEE T/);
 assert.equal(await page.locator('header b').innerText(),'LEE T');
 await page.locator('.workspace').getByText('Administrator',{exact:true}).first().waitFor();
 await page.locator('#language').selectOption('zh');
 assert.equal(await page.locator('html').getAttribute('lang'),'zh-Hans');
 await page.locator('#language').selectOption('ms');
 assert.equal(await page.locator('html').getAttribute('lang'),'ms');
});
test('desktop UI creates real master/product and Enter scans count once without auto-committing',async()=>{const page=await login();assert.equal(await page.locator('.stat').count(),4);await nav(page,'products');await page.locator('[data-catalog="master"]').click();await page.locator('[data-catalog="add-master"]').click();await page.locator('#master-name').fill('电子配件');await page.locator('#catalog-master button[type="submit"]').click();await page.getByText('电子配件',{exact:true}).waitFor();await nav(page,'products');await page.locator('[data-catalog="new"]').click();await page.locator('#product-name').fill('浏览器螺丝');await page.locator('#product-category').selectOption({label:'电子配件'});await page.locator('#product-cost').fill('1.25');await page.locator('#product-minimum').fill('5');await page.locator('#catalog-product button[type="submit"]').click();await page.locator('[data-stock="history"]').waitFor();const row=(await pool.query('SELECT id FROM products WHERE name=$1',['浏览器螺丝'])).rows[0],seed=new CatalogService(pool),detail=await seed.detail(row.id);await nav(page,'inbound');await scan(page,detail.qrToken,3);assert.equal((await seed.detail(row.id)).quantity,0);assert.equal(await page.locator('.main-panel input[type="number"]').count(),0);await page.locator('[data-stock="commit"]').click();await page.getByRole('heading',{name:'提交成功 · 更新后库存',exact:true}).waitFor();assert.equal((await seed.detail(row.id)).quantity,3);await nav(page,'home');await page.locator('.stat-grid').waitFor();await screenshot(page,'desktop');});
test('mobile employee has six entries, saved draft survives takeover, and old browser is revoked',async()=>{const first=await login('staff',true);assert.equal(await first.locator('.bottom button').count(),6);assert.ok(!/RM|库存总价值|员工管理/.test(await first.locator('.main-panel').innerText()));await nav(first,'inbound');await scan(first,(await new CatalogService(pool).detail(p.id)).qrToken,2);await first.locator('[data-stock="save"]').click();await first.getByText('已保存',{exact:true}).waitFor();const next=await login('staff',true);await nav(next,'inbound');await next.locator('[data-stock="load"]').click();await next.locator('table tbody strong').filter({hasText:/^2$/}).waitFor();await nav(first,'products');await first.locator('#login').waitFor();assert.equal((await new CatalogService(pool).detail(p.id)).quantity,0);await screenshot(next,'mobile');});
test('browser count refresh clears actual counts; complete report is immutable and never changes inventory',async()=>{const admin=await login(),employee=await login('staff',true);await publish(admin,'浏览器盘点');await nav(employee,'count');await employee.locator('[data-count="accept"]').click();await employee.getByText('已连接，可以盘点',{exact:true}).waitFor();await employee.locator('#count-token').fill((await new CatalogService(pool).detail(p.id)).qrToken);await employee.locator('#count-token').press('Enter');await employee.waitForFunction(id=>globalThis.document.querySelector(`[data-count-quantity="${id}"]`)?.value==='1',p.id);await employee.reload();await employee.locator('.workspace').waitFor();await nav(employee,'count');await employee.getByText('已连接，可以盘点',{exact:true}).waitFor();assert.equal(await employee.locator(`[data-count-quantity="${p.id}"]`).inputValue(),'');assert.equal(await employee.locator('[data-count="submit"]').isDisabled(),true);for(const [id,value]of [[p.id,'2'],[q.id,'0']]){await employee.locator(`[data-count-quantity="${id}"]`).fill(value);await employee.locator(`[data-count-quantity="${id}"]`).press('Tab');}await employee.locator('[data-count="submit"]').click();await employee.locator('.main-panel').getByText('报告已提交；报告数量不能修改。',{exact:true}).waitFor();assert.equal(await employee.locator('.main-panel input[type="number"]').count(),0);assert.equal((await new CatalogService(pool).detail(p.id)).quantity,0);assert.equal((await pool.query('SELECT * FROM count_reports')).rows.length,1);assert.equal(await employee.locator('[data-admin="export-report"]').count(),0);});
test('live admin cancellation clears browser counts; stale metadata cannot overwrite another administrator device',async()=>{const first=await login(),second=await login(),employee=await login('staff');await publish(first,'Cancel task');await nav(employee,'count');await employee.locator('[data-count="accept"]').click();await employee.getByText('已连接，可以盘点',{exact:true}).waitFor();await nav(first,'count');first.once('dialog',d=>d.accept());await first.locator('[data-count="cancel"]').click();await employee.getByText('该任务已被管理员取消或删除。',{exact:true}).waitFor();assert.equal(await employee.locator('[data-count-quantity]').count(),0);for(const page of [first,second]){await nav(page,'products');await page.locator(`[data-catalog="detail"][data-id="${p.id}"]`).click();await page.locator('[data-catalog="edit"]').click();}await second.locator('#product-name').fill('Newer device');await second.locator('#catalog-product button[type="submit"]').click();await second.locator('[data-stock="history"]').waitFor();await first.locator('#product-name').fill('Must not overwrite');await first.locator('#catalog-product button[type="submit"]').click();await first.getByText('资料已在其他设备更新，请重新打开后保存。',{exact:true}).waitFor();assert.equal((await new CatalogService(pool).detail(p.id)).name,'Newer device');});
test('late draft response and preceding scan response preserve the next scanner input on the same page',async()=>{const page=await login('staff',true);let releaseDraft,enteredDraft;const draftEntered=new Promise(r=>enteredDraft=r),draftGate=new Promise(r=>releaseDraft=r);await page.route('**/api/stock/draft',async route=>{enteredDraft();await draftGate;await route.continue();});await nav(page,'inbound');await draftEntered;const token=(await new CatalogService(pool).detail(p.id)).qrToken;await page.locator('#scan-token').fill(token);const draftFinished=page.waitForResponse(r=>r.url().endsWith('/api/stock/draft'));releaseDraft();await draftFinished;await page.locator('#stock-scan[aria-busy="false"]').waitFor();assert.equal(await page.locator('#scan-token').inputValue(),token);await page.unroute('**/api/stock/draft');let releaseScan,enteredScan;const scanEntered=new Promise(r=>enteredScan=r),scanGate=new Promise(r=>releaseScan=r);await page.route('**/api/products/by-token/*',async route=>{enteredScan();await scanGate;await route.continue();});await page.locator('#scan-token').press('Enter');await scanEntered;await page.locator('#scan-token').fill(token);releaseScan();await page.locator('table tbody strong').filter({hasText:/^1$/}).waitFor();assert.equal(await page.locator('#scan-token').inputValue(),token);await page.unroute('**/api/products/by-token/*');await page.locator('#scan-token').press('Enter');await page.locator('table tbody strong').filter({hasText:/^2$/}).waitFor();assert.equal((await new CatalogService(pool).detail(p.id)).quantity,0);});

test('admin downloads a new full backup from the browser without setting paths',async()=>{
 const page=await login();
 await nav(page,'backups');
 const link=page.locator('a[href="/api/backups/download-full"]');
 await link.waitFor();
 assert.equal(await page.locator('#backup-config').isVisible(),false);
 const pending=page.waitForEvent('download');
 await link.click();
 const download=await pending;
 assert.match(download.suggestedFilename(),/^warehouse-[a-f0-9-]+\.whb$/);
 assert.equal(await download.failure(),null);
 assert.equal((await backup.settings()).path1,null);
 await page.locator('details:has(#backup-config) summary').click();
 assert.equal(await page.locator('#backup-config').isVisible(),true);
});

test('admin can select and print two labels while the employee has no batch controls',async()=>{
 const page=await login();
 await page.context().addInitScript(()=>{globalThis.print=()=>{globalThis.printRequested=true;};});
 await nav(page,'products');
 const first=page.locator(`[data-qr-product="${p.id}"]`);
 const second=page.locator(`[data-qr-product="${q.id}"]`);
 const print=page.locator('[data-catalog="print-batch"]');
 await first.waitFor();
 assert.equal(await print.isDisabled(),true);
 await first.check();
 await second.check();
 const popupPromise=page.context().waitForEvent('page');
 await print.click();
 const popup=await popupPromise;
 await popup.waitForFunction(()=>globalThis.printRequested===true);
 assert.deepEqual(await popup.locator('.qr-label strong').allTextContents(),[p.productCode,q.productCode]);
 assert.equal(await popup.locator('.qr-label svg').count(),2);
 assert.equal(await popup.locator('main').evaluate(el=>globalThis.getComputedStyle(el).display),'grid');
 await first.uncheck();
 await second.uncheck();
 assert.equal(await print.isDisabled(),true);
 const employee=await login('staff',true);
 await nav(employee,'products');
 await employee.locator('[data-catalog="detail"]').first().waitFor();
 assert.equal(await employee.locator('[data-qr-product], [data-catalog="print-batch"]').count(),0);
});

test('browser Excel import previews without writes and adds products only on confirmation',async()=>{
 const page=await login();
 await nav(page,'products');
 await page.locator('[data-catalog="import"]').click();
 const d=page.locator('dialog:has(#catalog-import)');
 const file=d.locator('#import-workbook'),confirm=d.locator('#import-confirm');
 const upload=async rows=>file.setInputFiles({name:'products.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await workbookWithRows(rows)});
 await upload(productRow(2,'Bad stock',1,-1));
 await d.locator('button[type="submit"]').first().click();
 await d.locator('#import-result li').waitFor();
 assert.equal(await confirm.isVisible(),false);
 await upload(productRow(2,'Excel product',3.25,2));
 await d.locator('button[type="submit"]').first().click();
 await confirm.waitFor();
 assert.match(await d.locator('#import-result').innerText(),/Excel product.*3.25/);
 assert.equal((await catalog.list()).products.length,2);
 await confirm.click();
 await d.waitFor({state:'detached'});
 await page.locator('.catalog-name').filter({hasText:'Excel product'}).waitFor();
 const imported=(await catalog.list()).products.find(p=>p.name==='Excel product');
 assert.equal(imported.quantity,0);
 const employee=await login('staff',true);
 await nav(employee,'products');
 await employee.locator('[data-catalog="detail"]').first().waitFor();
 assert.equal(await employee.locator('[data-catalog="import"]').count(),0);
});

test('employee pairing controls display a QR and a fresh browser completes pairing before signing in',async()=>{
 const {EmployeePairing}=await import('../src/commercial/employee-pairing.mjs');
 const pairing=new EmployeePairing({serverId:randomUUID(),origin:'https://warehouse.test'});
 auth.pairing=pairing;
 try{
  const admin=await login();await nav(admin,'team');
  const downloadEvent=admin.waitForEvent('download');
  await admin.locator('a[href="/api/commercial/diagnostic-config"]').click();
  const download=await downloadEvent;
  assert.equal(download.suggestedFilename(),'paired-server.json');
  assert.deepEqual(JSON.parse(await readFile(await download.path(),'utf8')),{serverId:pairing.serverId,origin:pairing.origin});
  const issuance=admin.waitForResponse(response=>response.url().endsWith('/pairing/invite'));
  await admin.locator('[data-pairing="invite"]').click();
  const {invitation}=await (await issuance).json();
  const qr=admin.locator('dialog img');
  await qr.waitFor();
  await admin.waitForFunction(()=>globalThis.document.querySelector('dialog img')?.naturalWidth===320);
  await admin.locator('dialog button').click();
  await qr.waitFor({state:'detached'});
  const context=await browserFixture.browser.newContext();contexts.push(context);
  const employee=await context.newPage();employee.on('pageerror',e=>errors.push(e.message));
  const url=new URL(base);url.hash='pairing='+encodeURIComponent(JSON.stringify(invitation));
  await employee.goto(url.href);
  await employee.locator('#username').fill('staff');await employee.locator('#password').fill(password);
  await employee.locator('#login button').click();
  await employee.locator('.workspace').waitFor();
  assert.equal(new URL(employee.url()).hash,'');
  assert.equal((await context.cookies()).some(cookie=>cookie.name==='__Host-leet_device'&&cookie.httpOnly&&cookie.secure),true);
  admin.once('dialog',dialog=>dialog.accept());
  await admin.locator('[data-pairing="unbind"]').click();
  await employee.locator('#login').waitFor();
 }finally{
  delete auth.pairing;
 }
});

test('bundled Android workspace dispatches employee login, stock writes and live count events through its native bridge',async()=>{
 const admin=await login();
 const context=await browserFixture.browser.newContext({viewport:{width:390,height:844}});
 contexts.push(context);
 await context.addInitScript(()=>{
  const streams=new Map();
  const paths=[];
  let rejectLogin=true;
  globalThis.nativePaths=paths;
  globalThis.LeeTWarehouse={
   async request(id,method,path,body,csrf){
    paths.push(path);
    if(path==='/api/auth/login'&&rejectLogin){
     rejectLogin=false;
     globalThis.leetNativeReceive(id,'response',403,JSON.stringify({error:'ORIGIN_REJECTED'}));
     return;
    }
    try{
     const headers={...(body!==null?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})};
     const response=await fetch(path,{method,headers,body:body??undefined});
     globalThis.leetNativeReceive(id,'response',response.status,await response.text());
    }catch{globalThis.leetNativeReceive(id,'error',0,'');}
   },
   events(id,path){
    paths.push(path);
    const stream=new globalThis.EventSource(path);
    streams.set(id,stream);
    stream.onmessage=event=>globalThis.leetNativeReceive(id,'event',0,event.data);
    stream.onerror=()=>{stream.close();streams.delete(id);globalThis.leetNativeReceive(id,'error',0,'');};
   },
   closeEvents(id){streams.get(id)?.close();streams.delete(id);},
  };
 });
 const page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);
 await page.locator('#language').selectOption('zh');
 await page.locator('#username').fill('staff');
 await page.locator('#password').fill(password);
 await page.locator('#login button').click();
 await page.locator('#message').getByText(/403 ORIGIN_REJECTED/).waitFor();
 await page.locator('#login button').click();
 await page.locator('.workspace').waitFor();
 const seed=new CatalogService(pool),token=(await seed.detail(p.id)).qrToken;
 for(const direction of ['inbound','outbound']){
  await nav(page,direction);
  await scan(page,token,1);
  await page.locator('[data-stock="commit"]').click();
  await page.getByRole('heading',{name:'提交成功 · 更新后库存',exact:true}).waitFor();
  assert.equal((await seed.detail(p.id)).quantity,direction==='inbound'?1:0);
 }
 await publish(admin,'App bridge count');
 await nav(page,'count');
 await page.locator('[data-count="accept"]').click();
 await page.getByText('已连接，可以盘点',{exact:true}).waitFor();
 for(const id of [p.id,q.id]){
  await page.locator(`[data-count-quantity="${id}"]`).fill('0');
  await page.locator(`[data-count-quantity="${id}"]`).press('Tab');
 }
 await page.locator('[data-count="submit"]').click();
 await page.locator('.main-panel').getByText('报告已提交；报告数量不能修改。',{exact:true}).waitFor();
 assert.equal((await seed.detail(p.id)).quantity,0);
 const paths=await page.evaluate(()=>globalThis.nativePaths);
 assert.ok(paths.includes('/api/auth/login'));
 assert.ok(paths.some(path=>/^\/api\/count\/tasks\/[^/]+\/events\?/.test(path)));
});

test('late team response cannot pull a phone back from another module',async()=>{
 const page=await login('CTL LEE',true,'en');
 let entered,release;
 const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 await page.route('**/api/employees',async route=>{entered();await gate;await route.continue();});
 await nav(page,'team');await started;
 await nav(page,'profile');await page.locator('#admin-profile').waitFor();
 const delivered=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/employees');
 release();await (await delivered).finished();
 await page.evaluate(()=>new Promise(resolve=>globalThis.requestAnimationFrame(()=>globalThis.requestAnimationFrame(resolve))));
 assert.equal(await page.locator('.app-layout').getAttribute('data-page'),'profile');
 assert.equal(await page.locator('#admin-profile').isVisible(),true);
});

test('phone module change replaces the previous form with loading feedback until new data is ready',async()=>{
 const page=await login('CTL LEE',true,'en');
 await nav(page,'profile');await page.locator('#admin-profile').waitFor();
 let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 await page.route('**/api/master-data',async route=>{entered();await gate;await route.continue();});
 await nav(page,'exports');await started;
 try {
  assert.equal(await page.locator('#admin-profile').isVisible(),false,'Previous account form must not remain under the export tab');
  assert.equal(await page.locator('.main-panel').getByText('Loading…',{exact:true}).isVisible(),true);
 } finally {release();}
 await page.locator('#admin-export').waitFor();
});
