import assert from 'node:assert/strict';
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
import { BackupService } from '../src/backup/service.mjs';
import { HistoryCleanup } from '../src/stock/cleanup.mjs';
import { StockService } from '../src/stock/service.mjs';
import { createStockRoutes } from '../src/stock/routes.mjs';
import { DashboardService } from '../src/dashboard/service.mjs';
import { createApplicationRoutes } from '../src/dashboard/routes.mjs';

if (!process.argv[2]) throw Error('Provide the built RuoYi directory.');
const { pool } = await testPool();
const directory = await mkdtemp(join(tmpdir(), 'leet-ruoyi-browser-'));
let server, proxy, browser;
try {
  await migrate(pool);
  const auth = new AuthService(pool), catalog = new CatalogService(pool, auth), seed = new CatalogService(pool);
  const password = randomUUID();
  await auth.bootstrap(password);

  const category = await seed.addMaster('categories', { name: 'Fasteners' });
  const input = { name: 'Bolt', categoryId: category.id, locationId: UNASSIGNED, individualCost: '1.25', minimumStock: 2, supplierIds: [] };
  const actor = await auth.login('CTL LEE', password);
  const stock = new StockService(pool, auth),backup=new BackupService(pool,auth,join(directory,'data')),cleanup=new HistoryCleanup(pool,auth,backup);
  const a=join(directory,'a'),b=join(directory,'b');await Promise.all([a,b].map(path=>mkdir(path)));await backup.configure(actor.token,actor.csrf,{path1:a,path2:b});
  const product = await seed.create({ ...input, name: 'Stock bolt' });
  await stock.commit(actor.token, actor.csrf, { requestId: randomUUID(), kind: 'inbound', items: [{ productId: product.id, quantity: 5 }] });
  await pool.query("UPDATE inventory_events SET created_at=clock_timestamp()-INTERVAL '169 hours' WHERE product_id=$1",[product.id]);
  await stock.commit(actor.token,actor.csrf,{requestId:randomUUID(),kind:'inbound',items:[{productId:product.id,quantity:2}]});
  const before=await catalog.detail(product.id);
  server = createAuthServer({
    auth, publicOrigin: 'https://warehouse.test', ruoyiAdminDirectory: resolve(process.argv[2]),
    catalogRoutes: createCatalogRoutes({ auth, catalog, photos: new PhotoStore(pool, directory, auth) }),
    stockRoutes: createStockRoutes({ stock,cleanup }),
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
  await page.getByRole('menuitem', { name: 'Products', exact: true }).click();
  await page.locator('.el-table__row').filter({ hasText: 'Stock bolt' }).getByRole('button', { name: 'Details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Product details', exact: true });
  await details.getByRole('button', { name: 'Stock history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Stock history', exact: true });
  await history.getByRole('heading', { name: 'Stock bolt', exact: true }).waitFor();
  await history.getByText('Protection period ended',{exact:true}).waitFor();
  const boxes=history.getByRole('checkbox');assert.equal(await boxes.count(),2);assert.equal(await boxes.nth(0).isDisabled(),true);assert.equal(await boxes.nth(1).isEnabled(),true);
  await boxes.nth(1).check();
  const deleteButton=history.getByRole('button',{name:'Delete selected records (1)',exact:true});
  const prompt=name=>page.getByRole('dialog',{name,exact:true});
  const confirm=async()=>{
    await prompt('Review permanent cleanup').getByRole('button',{name:'Confirm',exact:true}).click();
    await prompt('Final cleanup confirmation').getByRole('button',{name:'Confirm',exact:true}).click();
  };
  // Cancelling either confirmation never creates a backup or deletes history.
  await deleteButton.click();await prompt('Review permanent cleanup').getByRole('button',{name:'Cancel',exact:true}).click();
  await deleteButton.click();await prompt('Review permanent cleanup').getByRole('button',{name:'Confirm',exact:true}).click();await prompt('Final cleanup confirmation').getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal((await stock.history(actor.token,product.id)).events.length,2);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM backup_runs')).rows[0].n),0);
  backup.fault=()=>{throw Object.assign(Error('unavailable'),{code:'ENOSPC'});};
  await deleteButton.click();await confirm();
  await history.getByText('A verified backup could not be created.',{exact:false}).waitFor();
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM inventory_events WHERE product_id=$1',[product.id])).rows[0].n),2);
  assert.equal((await pool.query('SELECT admin_backup_required FROM system_settings WHERE id=1')).rows[0].admin_backup_required,true);
  const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.endsWith(':cleanup')))));
  assert.ok(pending.requestId);assert.equal(await history.getByRole('button',{name:'Set current quantity',exact:true}).isDisabled(),true);
  backup.fault=null;await backup.create(actor.token,actor.csrf);
  assert.equal((await pool.query('SELECT admin_backup_required FROM system_settings WHERE id=1')).rows[0].admin_backup_required,false);
  // The server succeeds but the client loses the response. Verify after reopening, without a second deletion.
  await page.route('**/api/products/*/history-cleanup',async route=>{const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');},{times:1});
  await history.getByRole('button',{name:'Retry same cleanup',exact:true}).click();
  await prompt('Retry cleanup').getByRole('button',{name:'Confirm',exact:true}).click();
  await history.getByText('The result could not be confirmed.',{exact:false}).waitFor();
  assert.equal((await stock.history(actor.token,product.id)).events.length,1);
  assert.equal((await catalog.detail(product.id)).quantity,before.quantity);
  assert.equal((await catalog.detail(product.id)).inventoryVersion,before.inventoryVersion);
  const saved=(await pool.query("SELECT * FROM backup_runs WHERE kind='pre_cleanup' AND verified=true")).rows;
  assert.equal(saved.length,1);
  await history.getByRole('button',{name:'Close stock history',exact:true}).click();
  await details.getByRole('button',{name:'Stock history',exact:true}).click();
  await history.getByRole('button',{name:'Verify cleanup result',exact:true}).waitFor();
  // Confirmed cleanup and its refreshed rows are separate responses. Exercise a slow refresh
  // and keep the exact row assertion after that response has rendered.
  await page.route(url=>url.pathname==='/api/products/'+product.id+'/history',async route=>{
    const response=await route.fetch();await new Promise(resolve=>setTimeout(resolve,250));await route.fulfill({response});
  },{times:1});
  const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/products/'+product.id+'/history'&&response.request().method()==='GET');
  await history.getByRole('button',{name:'Verify cleanup result',exact:true}).click();
  await history.getByText('1 records deleted after a verified backup.',{exact:false}).waitFor();
  await refreshed;await history.getByRole('checkbox').waitFor({state:'visible'});
  assert.equal(await history.getByRole('checkbox').count(),1);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.endsWith(':cleanup')))),null);
  assert.equal((await cleanup.status(actor.token,product.id,pending.requestId)).deleted,1);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM backup_runs WHERE kind='pre_cleanup' AND verified=true")).rows[0].n),1);
  // Reconstruct the original pending request, then actually restore the pre-cleanup snapshot.
  await page.evaluate(value=>sessionStorage.setItem('warehouse-pending:'+value.owner+':cleanup',JSON.stringify(value.pending)),{owner:actor.user.id,pending});
  await backup.restore(actor.token,actor.csrf,{id:saved[0].id,confirm:'restore-entire-system'});
  await page.reload();
  const login=page.locator('.sign-in-form');await login.locator('input[type=text]').fill('CTL LEE');await login.locator('input[type=password]').fill(password);await login.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('menuitem',{name:'Products',exact:true}).click();
  await page.locator('.el-table__row').filter({hasText:'Stock bolt'}).getByRole('button',{name:'Details',exact:true}).click();
  await details.getByRole('button',{name:'Stock history',exact:true}).click();
  await history.getByRole('button',{name:'Verify cleanup result',exact:true}).click();
  await history.getByText('No confirmed result was found.',{exact:false}).waitFor();
  assert.equal(await history.getByRole('button',{name:'Retry same cleanup',exact:true}).isDisabled(),true);
  await history.getByRole('button',{name:'Discard obsolete cleanup',exact:true}).click();
  await prompt('Discard obsolete request').getByRole('button',{name:'Confirm',exact:true}).click();
  await prompt('Final discard confirmation').getByRole('button',{name:'Confirm',exact:true}).click();
  await history.getByText('Obsolete local request discarded.',{exact:false}).waitFor();
  assert.equal(await history.getByRole('checkbox').count(),2);
  const nextActor=await auth.login('CTL LEE',password);assert.equal((await stock.history(nextActor.token,product.id)).events.length,2);
  assert.equal((await catalog.detail(product.id)).quantity,before.quantity);
  await page.locator('.el-message-box').waitFor({state:'hidden'});
  await history.screenshot({path:process.argv[3]||join(directory,'cleanup.png'),animations:'disabled'});
  assert.deepEqual(errors,[]);
  console.log('Built RuoYi cleanup: 168h protection, both cancellations, failed-backup rollback, lost-response recovery, unchanged balance/version and actual restore discard gates passed.');
} finally {
  if(browser){await browser.browser.close();await browser.cleanup();}
  for(const instance of [proxy,server])if(instance){instance.closeAllConnections();await new Promise(resolve=>instance.close(resolve));}
  await pool.end();await rm(directory,{recursive:true,force:true});
}
