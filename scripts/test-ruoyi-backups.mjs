import assert from 'node:assert/strict';
import { BackupService } from '../src/backup/service.mjs';
import { createBackupRoutes } from '../src/backup/routes.mjs';
import { validateArchive, metadata } from '../src/backup/archive.mjs';
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
import { DashboardService } from '../src/dashboard/service.mjs';
import { createApplicationRoutes } from '../src/dashboard/routes.mjs';

if (!process.argv[2]) throw Error('Provide the built RuoYi directory.');
const { pool } = await testPool();
const directory = await mkdtemp(join(tmpdir(), 'leet-ruoyi-browser-'));
let server, proxy, browser, backup, full=false;
const primary=join(directory,'primary'),fallback=join(directory,'fallback'),dataDir=join(directory,'data');
await Promise.all([primary,fallback,dataDir].map(path=>mkdir(path)));
try {
  await migrate(pool);
  const auth = new AuthService(pool), catalog = new CatalogService(pool, auth), seed = new CatalogService(pool);
  const password = randomUUID();
  await auth.bootstrap(password);
  await auth.createEmployee({ username: 'staff', realName: 'Count worker', password });
  const category = await seed.addMaster('categories', { name: 'Fasteners' });
  const input = { name: 'Bolt', categoryId: category.id, locationId: UNASSIGNED, individualCost: '1.25', minimumStock: 2, supplierIds: [] };
  const actor = await auth.login('CTL LEE', password);
  const first = await seed.create({ ...input, name: 'Bolt A' });
  await seed.create({ ...input, name: 'Bolt B' });
  const stock = new StockService(pool, auth);
  backup = new BackupService(pool,auth,dataDir,{fault:async ({phase})=>{if(full && phase==='write')throw Object.assign(Error('full'),{code:'ENOSPC'});}});
  await stock.commit(actor.token, actor.csrf, { requestId: randomUUID(), kind: 'inbound', items: [{ productId: first.id, quantity: 5 }] });
  const before = await catalog.detail(first.id);
  server = createAuthServer({
    auth, publicOrigin: 'https://warehouse.test', ruoyiAdminDirectory: resolve(process.argv[2]),
    catalogRoutes: createCatalogRoutes({ auth, catalog, photos: new PhotoStore(pool, directory, auth) }),
    backupRoutes: createBackupRoutes({backup}),
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
  await page.goto(base + '/admin/');
  const login = page.locator('.sign-in-form');
  await login.locator('input[type=text]').fill('CTL LEE');
  await login.locator('input[type=password]').fill(randomUUID());
  await login.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('The username or password is incorrect, or the account is inactive.', { exact: true }).waitFor();
  assert.equal(await login.locator('input[type=password]').inputValue(), '');
  await login.locator('input[type=password]').fill(password);
  await login.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Warehouse overview', exact: true }).waitFor();
  await page.getByRole('menuitem',{name:'Backups',exact:true}).click();
  await page.getByText('Advanced automatic backup settings',{exact:true}).click();
  await page.getByRole('textbox',{name:'Primary backup folder',exact:true}).fill(primary);
  await page.getByRole('textbox',{name:'Fallback backup folder',exact:true}).fill(fallback);
  await page.getByRole('button',{name:'Save backup settings',exact:true}).click();
  await page.getByText('Backup settings saved.',{exact:true}).waitFor();
  const current=await backup.list(actor.token);
  await backup.configure(actor.token,actor.csrf,{path1:primary,path2:fallback,expectedRevision:current.config.revision});
  await page.getByRole('button',{name:'Save backup settings',exact:true}).click();
  await page.getByText('Backup settings changed on another device. Refresh before editing again.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Back up now',exact:true}).click();
  await page.getByText('Backup created and verified.',{exact:true}).waitFor();
  assert.equal((await backup.list(actor.token)).backups.length,1);
  await page.getByRole('button',{name:'Delete backup',exact:true}).click();
  await page.getByRole('dialog',{name:'Confirm backup deletion',exact:true}).getByRole('button',{name:'OK',exact:true}).click();
  await page.getByText('The last valid backup cannot be deleted.',{exact:true}).waitFor();
  const download=page.waitForEvent('download');
  await page.getByRole('link',{name:'Download full backup',exact:true}).click();
  const file=await download, path=join(directory,'download.whb');await file.saveAs(path);
  assert.match(file.suggestedFilename(),/\.whb$/);
  const verified=await validateArchive(path,await metadata(pool));assert.ok(verified.bytes>0);
  async function confirmTwice(title) {
    await page.getByRole('dialog',{name:title,exact:true}).getByRole('button',{name:'OK',exact:true}).click();
    await page.getByRole('dialog',{name:'Final confirmation',exact:true}).getByRole('button',{name:'OK',exact:true}).click();
  }
  const disabledProducts=page.locator('.el-menu-item.is-disabled').filter({hasText:/^Products$/});
  const enabledProducts=page.locator('.el-menu-item:not(.is-disabled)').filter({hasText:/^Products$/});
  await page.getByRole('button',{name:'Start maintenance',exact:true}).click();
  await confirmTwice('Confirm maintenance change');
  await page.getByText('Maintenance updated.',{exact:true}).waitFor();
  await disabledProducts.waitFor();
  await assert.rejects(stock.commit(actor.token,actor.csrf,{requestId:randomUUID(),kind:'inbound',items:[{productId:first.id,quantity:1}]}),failure=>failure.code==='MAINTENANCE');
  await page.getByRole('button',{name:'End maintenance',exact:true}).click();
  await confirmTwice('Confirm maintenance change');
  await enabledProducts.waitFor();
  full=true;
  await page.getByRole('button',{name:'Back up now',exact:true}).click();
  await page.getByText('Backup storage is full. Administrator operations are limited to this page until a new backup succeeds.',{exact:true}).waitFor();
  await disabledProducts.waitFor();
  full=false;
  await page.getByRole('button',{name:'Back up now',exact:true}).click();
  await page.getByText('Backup created and verified.',{exact:true}).waitFor();
  await enabledProducts.waitFor();
  async function upload() {
    await page.getByLabel('Choose backup file',{exact:true}).setInputFiles(path);
    await page.getByRole('button',{name:'Upload and verify',exact:true}).click();
    await page.getByText('Uploaded backup verified.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Restore uploaded backup',exact:true}).waitFor();
  }
  await upload();
  await stock.commit(actor.token,actor.csrf,{requestId:randomUUID(),kind:'inbound',items:[{productId:first.id,quantity:3}]});
  await page.route('**/api/backups/restore',route=>route.abort('connectionreset'));
  await page.getByRole('button',{name:'Restore uploaded backup',exact:true}).click();
  await confirmTwice('Restore entire system');
  await page.getByText('Restore result is unconfirmed. Sign out and sign in again, then verify the warehouse data. Do not repeat the restore.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Restore uploaded backup',exact:true}).isDisabled(),true);
  assert.equal((await catalog.detail(first.id)).quantity,8);
  assert.equal((await backup.list(actor.token)).backups.filter(row=>row.kind==='pre_restore').length,0);
  await page.unroute('**/api/backups/restore');
  await page.reload();
  await page.getByRole('menuitem',{name:'Backups',exact:true}).click();
  await upload();
  await page.getByRole('button',{name:'Restore uploaded backup',exact:true}).click();
  await confirmTwice('Restore entire system');
  await login.locator('input[type=password]').waitFor();
  await assert.rejects(auth.authorize(actor.token),failure=>failure.status===401);
  await login.locator('input[type=text]').fill('CTL LEE');await login.locator('input[type=password]').fill(password);
  await login.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Warehouse overview',exact:true}).waitFor();
  assert.equal((await catalog.detail(first.id)).quantity,before.quantity);
  assert.equal((await catalog.detail(first.id)).inventoryVersion,before.inventoryVersion);
  const fresh=await auth.login('CTL LEE',password);
  assert.equal((await backup.list(fresh.token)).backups.filter(row=>row.kind==='pre_restore').length,1);
  assert.deepEqual(errors,[]);
  console.log('Built RuoYi backups: real verified download/upload, stale settings, last-copy protection, maintenance/full-drive navigation, uncertain restore guard, preserved scene and restored balances passed.');
} finally {
  if(backup)await backup.waitForIdle();
  if(browser){await browser.browser.close();await browser.cleanup();}
  for(const instance of [proxy,server])if(instance){instance.closeAllConnections();await new Promise(resolve=>instance.close(resolve));}
  await pool.end();await rm(directory,{recursive:true,force:true});
}
