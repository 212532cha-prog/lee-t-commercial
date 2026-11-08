import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { BackupService } from '../src/backup/service.mjs';
import sharp from 'sharp';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testPool } from '../tests/helpers/database.mjs';
import { launchBrowser } from '../tests/helpers/browser.mjs';
import { migrate } from '../src/db/database.mjs';
import { AuthService } from '../src/auth/service.mjs';
import { createAuthServer } from '../src/auth/http.mjs';
import { CatalogService, UNASSIGNED } from '../src/catalog/service.mjs';
import { PhotoStore } from '../src/catalog/files.mjs';
import { createCatalogRoutes } from '../src/catalog/routes.mjs';
import { StockService } from '../src/stock/service.mjs';
import { createStockRoutes } from '../src/stock/routes.mjs';
import { DashboardService } from '../src/dashboard/service.mjs';
import { createApplicationRoutes } from '../src/dashboard/routes.mjs';

if (!process.argv[2]) throw Error('Provide the built RuoYi directory.');
const { pool } = await testPool();
const directory = await mkdtemp(join(tmpdir(), 'leet-ruoyi-browser-'));
let server, proxy, browser, backup;
try {
  await migrate(pool);
  const auth = new AuthService(pool), catalog = new CatalogService(pool, auth), seed = new CatalogService(pool);
  const password = randomUUID();
  await auth.bootstrap(password);

  const category = await seed.addMaster('categories', { name: 'Fasteners' });
  const input = { name: 'Bolt', categoryId: category.id, locationId: UNASSIGNED, individualCost: '1.25', minimumStock: 2, supplierIds: [] };
  const actor = await auth.login('CTL LEE', password);
  const stock = new StockService(pool, auth);
  const backupData=join(directory,'data'),primary=join(directory,'primary'),fallback=join(directory,'fallback');
  await Promise.all([backupData,primary,fallback].map(path=>mkdir(path)));
  backup=new BackupService(pool,auth,backupData);
  await backup.configure(actor.token,actor.csrf,{path1:primary,path2:fallback});
  const product = await seed.create({ ...input, name: 'Stock bolt' });
  await stock.commit(actor.token, actor.csrf, { requestId: randomUUID(), kind: 'inbound', items: [{ productId: product.id, quantity: 5 }] });
  const before=await catalog.detail(product.id);
  server = createAuthServer({
    auth, publicOrigin: 'https://warehouse.test', ruoyiAdminDirectory: resolve(process.argv[2]),
    catalogRoutes: createCatalogRoutes({ auth, catalog, photos: new PhotoStore(pool, directory, auth) }),
    stockRoutes: createStockRoutes({ stock }),
    applicationRoutes: createApplicationRoutes({ auth, dashboard: new DashboardService(pool, auth) }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let base;
  // Localhost UI transport only. Production TLS validation is covered by the mandatory TLS suite.
  proxy = createServer((req, res) => {
    const headers = { ...req.headers };
    if (headers.origin === base) headers.origin = 'https://warehouse.test';
    const upstream = request({ host: '127.0.0.1', port: server.address().port, path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
      res.on('close', () => response.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  base = 'http://localhost:' + proxy.address().port;
  browser = await launchBrowser();
  const errors = [];
  const page = await browser.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('#username').fill('CTL LEE');
  await page.locator('#password').fill(password);
  await page.locator('#login button').click();
  await page.locator('.workspace').waitFor();
  await page.goto(base + '/admin/');
  async function signInAgain(){const form=page.locator('.sign-in-form');await form.locator('input[type=text]').fill('CTL LEE');await form.locator('input[type=password]').fill(password);await form.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Warehouse overview',exact:true}).waitFor();}
  async function openStock(pending=false){await page.getByRole('menuitem',{name:'Stock movements',exact:true}).click();await page.getByRole('heading',{name:'Stock movements',exact:true}).waitFor();if(!pending)await page.getByLabel('Product QR',{exact:true}).waitFor();}
  await openStock();
  const scan=async()=>{await page.getByLabel('Product QR',{exact:true}).fill(before.qrToken);await page.getByLabel('Product QR',{exact:true}).press('Enter');};
  const row=page.locator('.movement-items .el-table__row').filter({hasText:'Stock bolt'});
  await page.route('**/api/products/by-token/*',async route=>{await new Promise(resolve=>setTimeout(resolve,80));await route.continue();});
  for(let n=0;n<3;n++)await scan();
  await row.getByText('3',{exact:true}).waitFor();await page.unroute('**/api/products/by-token/*');
  if(process.argv[3])await page.screenshot({path:process.argv[3],fullPage:true});
  assert.equal((await catalog.detail(product.id)).quantity,5);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByText('Draft saved.',{exact:true}).waitFor();
  assert.equal((await stock.draft(actor.token)).draft.items[0].quantity,3);
  await page.reload();await openStock();assert.equal(await page.locator('.movement-items .el-table__row').count(),0);
  await page.getByRole('button',{name:'Load draft',exact:true}).click();await row.getByText('3',{exact:true}).waitFor();
  let original;
  await page.route('**/api/stock/transactions',async route=>{original=route.request().postDataJSON();const response=await route.fetch();assert.equal(response.status(),200);await route.abort('connectionreset');},{times:1});
  await page.getByRole('button',{name:'Submit stock',exact:true}).click();await page.getByRole('heading',{name:'Transaction awaiting verification',exact:true}).waitFor();
  await page.getByText('The result could not be confirmed. Verify any pending request before trying again.',{exact:true}).waitFor();
  assert.ok(original.draftRevision);assert.ok(original.expectedVersions[product.id]);assert.equal(original.restoreMarker,null);
  assert.equal((await catalog.detail(product.id)).quantity,8);
  await page.reload();await openStock(true);await page.getByText(new RegExp(original.requestId)).waitFor();
  const cookie=(await page.context().cookies()).find(cookie=>cookie.name==='__Host-warehouse_session');await auth.logout(cookie.value);
  await page.getByRole('button',{name:'Retry original request',exact:true}).click();
  await page.locator('.sign-in-form').waitFor();await signInAgain();await openStock(true);await page.getByText(new RegExp(original.requestId)).waitFor();
  await page.route('**/api/stock/draft',route=>route.abort('connectionreset'),{times:1});
  await page.getByRole('button',{name:'Verify result',exact:true}).click();await page.getByText('Transaction verified as committed.',{exact:true}).waitFor();
  await page.getByText('The stock transaction is committed, but draft status could not be refreshed. Refresh the draft before continuing.',{exact:true}).waitFor();
  assert.equal((await catalog.detail(product.id)).quantity,8);assert.equal((await stock.draft(actor.token)).draft,null);
  const saved=await stock.saveDraft(actor.token,actor.csrf,{kind:'inbound',expectedRevision:'0',items:[{productId:product.id,quantity:2}]});
  await page.getByRole('button',{name:'Refresh draft',exact:true}).click();await page.getByText('Saved draft checked. Load it to replace the current list.',{exact:true}).waitFor();
  await scan();await row.getByText('1',{exact:true}).waitFor();
  let response=page.waitForResponse(r=>r.url()===base+'/api/stock/transactions');await page.getByRole('button',{name:'Submit stock',exact:true}).click();assert.equal((await response).status(),200);
  await page.getByText('Stock transaction committed.',{exact:true}).waitFor();assert.equal((await catalog.detail(product.id)).quantity,9);assert.equal((await stock.draft(actor.token)).draft.revision,saved.revision);
  await page.getByRole('button',{name:'Stock out',exact:true}).click();
  await page.getByLabel('Search product name or code',{exact:true}).fill(product.productCode);await page.getByRole('button',{name:'Search products',exact:true}).click();
  await page.getByRole('button',{name:'Add '+product.productCode,exact:true}).click();
  for(let n=0;n<9;n++)await page.getByRole('button',{name:'Increase '+product.productCode,exact:true}).click();await row.getByText('10',{exact:true}).waitFor();
  await page.getByRole('menuitem',{name:'Overview',exact:true}).click();await page.getByRole('dialog',{name:'Unsaved stock list',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('heading',{name:'Stock movements',exact:true}).waitFor();assert.match(await page.getByRole('menuitem',{name:'Stock movements',exact:true}).getAttribute('class'),/is-active/);
  const warning=page.getByRole('dialog',{name:'Insufficient stock',exact:true}),final=page.getByRole('dialog',{name:'Confirm negative stock',exact:true});
  await page.getByRole('button',{name:'Submit stock',exact:true}).click();await warning.getByText(/available 9, requested 10/).waitFor();await warning.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await catalog.detail(product.id)).quantity,9);
  await page.getByRole('button',{name:'Submit stock',exact:true}).click();await warning.getByRole('button',{name:'OK',exact:true}).click();await final.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await catalog.detail(product.id)).quantity,9);
  response=page.waitForResponse(r=>r.url()===base+'/api/stock/transactions');await page.getByRole('button',{name:'Submit stock',exact:true}).click();await warning.getByRole('button',{name:'OK',exact:true}).click();
  await stock.commit(actor.token,actor.csrf,{requestId:randomUUID(),kind:'inbound',items:[{productId:product.id,quantity:1}]});
  await final.getByRole('button',{name:'OK',exact:true}).click();assert.equal((await response).status(),409);
  await page.getByText('Stock changed on another device. Submit again to review the latest quantities.',{exact:true}).waitFor();assert.equal((await catalog.detail(product.id)).quantity,10);assert.equal(await page.getByRole('heading',{name:'Transaction awaiting verification',exact:true}).count(),0);
  response=page.waitForResponse(r=>r.url()===base+'/api/stock/transactions');await page.getByRole('button',{name:'Submit stock',exact:true}).click();assert.equal((await response).status(),200);await page.getByText('Stock transaction committed.',{exact:true}).waitFor();assert.equal((await catalog.detail(product.id)).quantity,0);
  await scan();await row.getByText('1',{exact:true}).waitFor();
  await page.route('**/api/stock/transactions',async route=>{const response=await route.fetch();assert.equal(response.status(),200);await route.abort('connectionreset');},{times:1});
  await page.getByRole('button',{name:'Submit stock',exact:true}).click();await warning.getByRole('button',{name:'OK',exact:true}).click();await final.getByRole('button',{name:'OK',exact:true}).click();await page.getByText('The result could not be confirmed. Verify any pending request before trying again.',{exact:true}).waitFor();assert.equal((await catalog.detail(product.id)).quantity,-1);
  await page.reload();await openStock(true);await page.getByRole('button',{name:'Verify result',exact:true}).click();await page.getByRole('heading',{name:'Stock-out committed quantities',exact:true}).waitFor();assert.match(await page.getByRole('button',{name:'Stock out',exact:true}).getAttribute('class'),/el-button--primary/);await page.getByText(/Changed -1/).waitFor();
  await page.getByRole('button',{name:'Load draft',exact:true}).click();await row.getByText('2',{exact:true}).waitFor();
  const changed=await stock.saveDraft(actor.token,actor.csrf,{kind:'inbound',expectedRevision:saved.revision,items:[{productId:product.id,quantity:4}]});
  await page.getByRole('button',{name:'Increase '+product.productCode,exact:true}).click();
  await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByText('The saved draft changed on another device. Refresh the draft before saving or submitting.',{exact:true}).waitFor();assert.equal((await stock.draft(actor.token)).draft.revision,changed.revision);
  response=page.waitForResponse(r=>r.url()===base+'/api/stock/transactions');await page.getByRole('button',{name:'Submit stock',exact:true}).click();assert.equal((await response).status(),409);await page.getByText('The saved draft changed on another device. Refresh the draft before saving or submitting.',{exact:true}).waitFor();assert.equal((await catalog.detail(product.id)).quantity,-1);
  await page.getByRole('button',{name:'Refresh draft',exact:true}).click();await page.getByText('Saved draft checked. Load it to replace the current list.',{exact:true}).waitFor();await page.getByRole('button',{name:'Load draft',exact:true}).click();await page.getByRole('dialog',{name:'Unsaved stock list',exact:true}).getByRole('button',{name:'OK',exact:true}).click();await row.getByText('4',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Discard draft',exact:true}).click();await page.getByRole('dialog',{name:'Discard draft',exact:true}).getByRole('button',{name:'OK',exact:true}).click();await page.getByText('Saved draft discarded.',{exact:true}).waitFor();assert.equal((await stock.draft(actor.token)).draft,null);
  const svg=await QRCode.toString(before.qrToken,{type:'svg',width:256,margin:4}),pixels=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  await page.evaluate(({data,width,height})=>{const canvas=globalThis.document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').putImageData(new globalThis.ImageData(new Uint8ClampedArray(data),width,height),0,0);globalThis.navigator.mediaDevices.getUserMedia=async()=>{const stream=canvas.captureStream(10),track=stream.getVideoTracks()[0];const clock=globalThis.setInterval(()=>{if(track.readyState==='ended'){globalThis.clearInterval(clock);return}canvas.getContext('2d').putImageData(new globalThis.ImageData(new Uint8ClampedArray(data),width,height),0,0);},100);globalThis.__leetCamera=stream;return stream;};},{data:[...pixels.data],width:pixels.info.width,height:pixels.info.height});
  await page.getByRole('button',{name:'Start camera',exact:true}).click();await row.getByText('1',{exact:true}).waitFor().catch(async failure=>{console.log('Camera diagnostics',await page.locator('.el-alert').allTextContents(),await page.locator('video').evaluateAll(videos=>videos.map(v=>({width:v.videoWidth,height:v.videoHeight,ready:v.readyState,paused:v.paused}))),errors);throw failure;});
  assert.equal(await page.evaluate(()=>globalThis.__leetCamera.getTracks().every(track=>track.readyState==='ended')),true);
  await new Promise(resolve=>setTimeout(resolve,1000));assert.equal(await row.getByText('1',{exact:true}).count(),1);
  await row.getByRole('button',{name:'Remove',exact:true}).click();
  await page.evaluate(()=>{globalThis.navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError');};});await page.getByRole('button',{name:'Start camera',exact:true}).click();await page.getByText('Camera unavailable. Allow camera access in system settings, or use a scanner or product search.',{exact:true}).waitFor();
  assert.equal((await catalog.detail(product.id)).quantity,-1);
  const countBefore=Number((await pool.query('SELECT count(*) AS n FROM stock_requests')).rows[0].n);
  await scan();await row.getByText('1',{exact:true}).waitFor();
  await page.evaluate(()=>{globalThis.__originalStorageSet=globalThis.Storage.prototype.setItem;globalThis.Storage.prototype.setItem=function(key,value){if(key.startsWith('warehouse-pending:'))throw new DOMException('full','QuotaExceededError');return globalThis.__originalStorageSet.call(this,key,value);};});
  await page.getByRole('button',{name:'Submit stock',exact:true}).click();await page.getByText('This window cannot retain a pending transaction safely. Close and reopen the app before submitting.',{exact:true}).waitFor();
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM stock_requests')).rows[0].n),countBefore);
  await page.evaluate(()=>{globalThis.Storage.prototype.setItem=globalThis.__originalStorageSet;});await page.reload();await openStock();
  const savedWarehouse=await backup.create(actor.token,actor.csrf);let obsoleteRequest;
  await scan();await row.getByText('1',{exact:true}).waitFor();
  await page.route('**/api/stock/transactions',async route=>{obsoleteRequest=route.request().postDataJSON();const response=await route.fetch();assert.equal(response.status(),200);await route.abort('connectionreset');},{times:1});
  await page.getByRole('button',{name:'Submit stock',exact:true}).click();await page.getByText('The result could not be confirmed. Verify any pending request before trying again.',{exact:true}).waitFor();assert.equal((await catalog.detail(product.id)).quantity,0);
  await backup.restore(actor.token,actor.csrf,{id:savedWarehouse.id,confirm:'restore-entire-system'});await page.reload();await page.locator('.sign-in-form').waitFor();await signInAgain();await openStock(true);
  await page.getByRole('button',{name:'Retry original request',exact:true}).click();await page.getByText('The warehouse was restored after this request was prepared. Verify its result before discarding the obsolete request.',{exact:true}).waitFor();
  assert.equal((await catalog.detail(product.id)).quantity,-1);assert.equal(await page.getByRole('button',{name:'Retry original request',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Verify result',exact:true}).click();await page.getByRole('button',{name:'Discard obsolete request',exact:true}).click();
  await page.getByRole('dialog',{name:'Discard obsolete request',exact:true}).getByRole('button',{name:'OK',exact:true}).click();await page.getByRole('dialog',{name:'Final request confirmation',exact:true}).getByRole('button',{name:'OK',exact:true}).click();
  await page.getByLabel('Product QR',{exact:true}).waitFor();assert.equal(Number((await pool.query('SELECT count(*) AS n FROM stock_requests WHERE id=$1',[obsoleteRequest.requestId])).rows[0].n),0);
  await page.goto(base);await page.locator('.workspace').waitFor();await page.locator('[data-page="outbound"]').first().click();
  await page.locator('#scan-token').fill(before.qrToken);await page.locator('#scan-token').press('Enter');await page.locator('[data-stock="commit"]').waitFor();
  const dialogs=[];const accept=async dialog=>{dialogs.push(dialog.message());await dialog.accept();};page.on('dialog',accept);
  await page.locator('[data-stock="commit"]').click();await page.getByRole('heading',{name:'Committed · Updated stock',exact:true}).waitFor();page.off('dialog',accept);
  assert.equal(dialogs.length,2);assert.match(dialogs[0],/Insufficient stock/);assert.equal((await catalog.detail(product.id)).quantity,-2);
  assert.deepEqual(errors,[]);console.log('Built RuoYi stock: Enter scans, search, drafts, lost response recovery, two negative confirmations, concurrent balance/draft rejection, decoded camera frames, permissions, storage failures, session expiry, real restore protection and original workspace parity passed.');
} finally {
  if(backup)await backup.waitForIdle();
  if(browser){await browser.browser.close();await browser.cleanup();}
  for(const instance of [proxy,server])if(instance){instance.closeAllConnections();await new Promise(resolve=>instance.close(resolve));}
  await pool.end();await rm(directory,{recursive:true,force:true});
}
