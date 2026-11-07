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
  const stock = new StockService(pool, auth);
  const product = await seed.create({ ...input, name: 'Stock bolt' });
  await stock.commit(actor.token, actor.csrf, { requestId: randomUUID(), kind: 'inbound', items: [{ productId: product.id, quantity: 5 }] });
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
  await page.getByRole('menuitem', { name: 'Products', exact: true }).click();
  await page.locator('.el-table__row').filter({ hasText: 'Stock bolt' }).getByRole('button', { name: 'Details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Product details', exact: true });
  await details.getByRole('button', { name: 'Stock history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Stock history', exact: true });
  await history.getByRole('heading', { name: 'Stock bolt', exact: true }).waitFor();
  async function confirmOverwrite() {
    await page.getByRole('dialog', { name: 'Confirm stock change', exact: true }).getByRole('button', { name: 'OK', exact: true }).click();
    await page.getByRole('dialog', { name: 'Final stock confirmation', exact: true }).getByRole('button', { name: 'OK', exact: true }).click();
  }
  await history.getByRole('button', { name: 'Set current quantity', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Set current quantity', exact: true });
  await editor.getByRole('textbox').fill('20');
  await page.route('**/api/products/*/quantity', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort('failed');
  }, { times: 1 });
  await editor.getByRole('button', { name: 'Save stock quantity', exact: true }).click();
  await confirmOverwrite();
  await editor.getByText('The result could not be confirmed.', { exact: false }).waitFor();
  const committed = await catalog.detail(product.id);
  assert.equal(committed.quantity, 20);
  await editor.getByRole('button', { name: 'Save stock quantity', exact: true }).click();
  await confirmOverwrite();
  await editor.getByText('Stock quantity changed.', { exact: false }).waitFor();
  assert.equal((await catalog.detail(product.id)).inventoryVersion, committed.inventoryVersion);
  assert.equal((await stock.history(actor.token, product.id)).events.length, 1);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await history.getByRole('button', { name: 'Refresh stock history', exact: true }).click();
  await history.getByText(/Current stock 20/).waitFor();
  await history.getByRole('button', { name: 'Set current quantity', exact: true }).click();
  await editor.getByRole('textbox').fill('30');
  await stock.commit(actor.token, actor.csrf, { requestId: randomUUID(), kind: 'inbound', items: [{ productId: product.id, quantity: 3 }] });
  await editor.getByRole('button', { name: 'Save stock quantity', exact: true }).click();
  await confirmOverwrite();
  await editor.getByText('Stock quantity changed.', { exact: false }).waitFor();
  assert.equal((await catalog.detail(product.id)).quantity, 23);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await history.getByRole('button', { name: 'Refresh stock history', exact: true }).click();
  await history.getByText(/Current stock 23/).waitFor();
  await history.getByRole('button', { name: 'Correct record', exact: true }).first().click();
  const correction = page.getByRole('dialog', { name: 'Correct stock record', exact: true });
  await correction.getByRole('textbox').fill('4');
  await correction.getByRole('button', { name: 'Save stock quantity', exact: true }).click();
  await page.getByRole('dialog', { name: 'Confirm stock change', exact: true }).getByRole('button', { name: 'OK', exact: true }).click();
  await history.getByText(/Current stock 24/).waitFor();
  assert.equal((await catalog.detail(product.id)).quantity, 24);
  await history.getByRole('button', { name: 'Correct record', exact: true }).nth(1).click();
  await correction.getByRole('textbox').fill('9');
  await correction.getByRole('button', { name: 'Save stock quantity', exact: true }).click();
  await page.getByRole('dialog', { name: 'Confirm stock change', exact: true }).getByRole('button', { name: 'OK', exact: true }).click();
  await correction.getByText('A later quantity setting protects the current stock.', { exact: false }).waitFor();
  assert.equal((await catalog.detail(product.id)).quantity, 24);
  await correction.getByRole('button', { name: 'Cancel', exact: true }).click();
  const oldest = (await stock.history(actor.token, product.id, { order: 'oldest' })).events[0];
  await pool.query("UPDATE inventory_events SET created_at=clock_timestamp()-interval '169 hours' WHERE id=$1", [oldest.id]);
  await history.getByRole('button', { name: 'Refresh stock history', exact: true }).click();
  await history.getByText('Protection period ended', { exact: true }).waitFor();
  assert.equal(await history.getByRole('button', { name: 'Correct record', exact: true }).nth(1).isDisabled(), true);
  await stock.commit(actor.token, actor.csrf, { requestId: randomUUID(), kind: 'outbound', items: [{ productId: product.id, quantity: 1 }] });
  await history.locator('.history-toolbar .el-select').first().click();
  await page.getByRole('option', { name: 'Stock out', exact: true }).click();
  await history.getByRole('button', { name: 'Refresh stock history', exact: true }).click();
  await history.getByText(/Current stock 23/).waitFor();
  assert.equal(await history.locator('.el-table__row').count(), 1);
  await page.waitForFunction(() => [...globalThis.document.querySelectorAll('.el-message-box__wrapper')].every(element => element.getClientRects().length === 0));
  await history.screenshot({ path: process.argv[3] || join(directory, 'history.png') });
  await history.getByRole('button', { name: 'Close stock history', exact: true }).click();
  await details.locator('.el-descriptions__body').getByText('23', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Built RuoYi inventory: lost-response retry, concurrent-stock rejection, correction, manual-anchor preservation, immutable history and filters passed.');
} finally {
  if (browser) { await browser.browser.close(); await browser.cleanup(); }
  for (const instance of [proxy, server]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
