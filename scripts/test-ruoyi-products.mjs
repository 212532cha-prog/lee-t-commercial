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
  await page.getByRole('menuitem', { name: 'Master data', exact: true }).click();
  await page.getByRole('button', { name: 'Add record', exact: true }).click();
  const masterEditor = page.getByRole('dialog', { name: 'Add master data', exact: true });
  await masterEditor.getByRole('textbox').first().fill('Browser category');
  await masterEditor.getByRole('button', { name: 'Save record', exact: true }).click();
  const masterRow = page.locator('.el-table__row').filter({ hasText: 'Browser category' });
  await masterRow.getByRole('button', { name: 'Edit record', exact: true }).click();
  const editMaster = page.getByRole('dialog', { name: 'Edit master data', exact: true });
  const master = (await catalog.masters()).categories.find(row => row.name === 'Browser category');
  const linkedMasterProduct = await seed.create({ ...input, name: 'Product with removed category', categoryId: master.id });
  await seed.editMaster('categories', master.id, { name: 'Category changed elsewhere', revision: master.revision });
  await editMaster.getByRole('textbox').first().fill('Stale master change');
  await editMaster.getByRole('button', { name: 'Save record', exact: true }).click();
  await editMaster.getByText('Another device changed this record.', { exact: false }).waitFor();
  assert.equal((await catalog.masters()).categories.find(row => row.id === master.id).name, 'Category changed elsewhere');
  await editMaster.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh master data', exact: true }).click();
  await page.locator('.el-table__row').filter({ hasText: 'Category changed elsewhere' }).getByRole('button', { name: 'Delete record', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete master data', exact: true }).getByRole('button', { name: 'OK', exact: true }).click();
  await page.getByRole('dialog', { name: 'Final confirmation', exact: true }).getByRole('button', { name: 'OK', exact: true }).click();
  await page.getByText('Master data deleted.', { exact: true }).waitFor();
  assert.equal((await catalog.masters()).categories.some(row => row.id === master.id), false);
  await page.getByText('Locations', { exact: true }).click();
  const builtIn = page.locator('.el-table__row').filter({ hasText: 'Built-in location' });
  await builtIn.waitFor();
  assert.equal(await builtIn.getByRole('button').count(), 0);
  await page.getByRole('menuitem', { name: 'Products', exact: true }).click();
  await page.locator('.el-table__row').filter({ hasText: 'Product with removed category' }).getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('dialog', { name: 'Product details', exact: true }).getByRole('button', { name: 'Edit product', exact: true }).click();
  const retainedEditor = page.getByRole('dialog', { name: 'Edit product', exact: true });
  await retainedEditor.getByText('Previous category Category changed elsewhere (deleted) will be retained.', { exact: true }).waitFor();
  await retainedEditor.getByRole('textbox').first().fill('Retained deleted category');
  await retainedEditor.getByRole('button', { name: 'Save product', exact: true }).click();
  await page.getByRole('dialog', { name: 'Product details', exact: true }).getByRole('heading', { name: 'Retained deleted category', exact: true }).waitFor();
  const retainedProduct = await catalog.detail(linkedMasterProduct.id);
  assert.equal(retainedProduct.categoryDeleted, true);
  assert.equal(retainedProduct.categoryName, 'Category changed elsewhere');
  assert.equal(retainedProduct.quantity, 0);
  const retainedDetails = page.getByRole('dialog', { name: 'Product details', exact: true });
  await retainedDetails.locator('button:not([disabled])').filter({ hasText: 'Edit product' }).waitFor();
  await retainedDetails.locator('.el-dialog__headerbtn').click();

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
  assert.equal(await staff.getByRole('menuitem', { name: 'Master data', exact: true }).count(), 0);
  console.log('Built RuoYi browser: product/master creation, stale edit rejection, deletion, built-in location protection, stock preservation and employee denial passed.');
} finally {
  if (browser) { await browser.browser.close(); await browser.cleanup(); }
  for (const instance of [proxy, server]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
