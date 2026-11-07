import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
  await auth.createEmployee({ username: 'staff', realName: 'Staff', password });
  const category = await seed.addMaster('categories', { name: 'Fasteners' });
  const input = { name: 'Bolt', categoryId: category.id, locationId: UNASSIGNED, individualCost: '1.25', minimumStock: 2, supplierIds: [] };
  server = createAuthServer({
    auth, publicOrigin: 'https://warehouse.test', ruoyiAdminDirectory: resolve(process.argv[2]),
    catalogRoutes: createCatalogRoutes({ auth, catalog, photos: new PhotoStore(pool, directory, auth) }),
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
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add product', exact: true });
  await editor.getByRole('textbox').first().fill('Browser bolt');
  await editor.locator('.el-select').first().click();
  await page.getByRole('option', { name: 'Fasteners', exact: true }).click();
  await editor.getByRole('button', { name: 'Save product', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Product details', exact: true });
  await details.getByRole('heading', { name: 'Browser bolt', exact: true }).waitFor();
  const id = (await pool.query('SELECT id FROM products WHERE name=$1', ['Browser bolt'])).rows[0].id;
  assert.equal((await catalog.detail(id)).quantity, 0);
  await details.getByRole('button', { name: 'Edit product', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit product', exact: true });
  const before = await catalog.detail(id);
  await seed.update(id, { ...input, name: 'Updated on another device', detailsVersion: before.detailsVersion });
  await edit.getByRole('textbox').first().fill('Stale browser change');
  await edit.getByRole('button', { name: 'Save product', exact: true }).click();
  await edit.getByText('Another device changed this product.', { exact: false }).waitFor();
  assert.equal((await catalog.detail(id)).name, 'Updated on another device');
  await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
  await details.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete product', exact: true }).getByRole('button', { name: 'OK', exact: true }).click();
  await page.getByRole('dialog', { name: 'Final confirmation', exact: true }).getByRole('button', { name: 'OK', exact: true }).click();
  await page.getByText('Product deleted.', { exact: true }).waitFor();
  assert.equal((await pool.query('SELECT id FROM products WHERE id=$1', [id])).rows.length, 0);
  await page.waitForFunction(() => [...globalThis.document.querySelectorAll('.el-overlay')].every(element => element.getClientRects().length === 0));
  await page.screenshot({ path: process.argv[3] || join(directory, 'products.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await page.context().close();
  const staff = await browser.browser.newPage();
  await staff.goto(base);
  await staff.locator('#username').fill('staff');
  await staff.locator('#password').fill(password);
  await staff.locator('#login button').click();
  await staff.locator('.workspace').waitFor();
  await staff.goto(base + '/admin/');
  await staff.getByText('An Administrator account is required.', { exact: true }).waitFor();
  assert.equal(await staff.getByRole('menuitem', { name: 'Products', exact: true }).count(), 0);
  console.log('Built RuoYi browser: create, stale edit rejection, permanent deletion, stock preservation and employee denial passed.');
} finally {
  if (browser) { await browser.browser.close(); await browser.cleanup(); }
  for (const instance of [proxy, server]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
