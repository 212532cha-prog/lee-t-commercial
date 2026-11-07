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
  await auth.createEmployee({ username: 'staff', realName: 'Count worker', password });
  const category = await seed.addMaster('categories', { name: 'Fasteners' });
  const input = { name: 'Bolt', categoryId: category.id, locationId: UNASSIGNED, individualCost: '1.25', minimumStock: 2, supplierIds: [] };
  const actor = await auth.login('CTL LEE', password);
  const first = await seed.create({ ...input, name: 'Bolt A' });
  await seed.create({ ...input, name: 'Bolt B' });
  const stock = new StockService(pool, auth);
  await stock.commit(actor.token, actor.csrf, { requestId: randomUUID(), kind: 'inbound', items: [{ productId: first.id, quantity: 5 }] });
  await stock.commit(actor.token, actor.csrf, { requestId: randomUUID(), kind: 'outbound', items: [{ productId: first.id, quantity: 8 }] });
  for (let n = 0; n < 99; n++) await seed.create({ ...input, name: 'Cost product ' + n });
  const before = await catalog.detail(first.id);
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
  const negative = page.locator('.surface').filter({ has: page.getByRole('heading', { name: 'Negative stock', exact: true }) });
  await negative.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await negative.getByText('Read', { exact: true }).waitFor();
  assert.equal((await new DashboardService(pool, auth).get(actor.token)).negative[0].read, true);
  const move = (kind, quantity) => stock.commit(actor.token, actor.csrf, { requestId: randomUUID(), kind, items: [{ productId: first.id, quantity }] });
  await move('inbound', 3); await move('outbound', 1);
  await page.getByRole('button', { name: 'Refresh stock', exact: true }).click();
  await negative.getByRole('button', { name: 'Mark as read', exact: true }).waitFor();
  await move('inbound', 1); await move('outbound', 1);
  await negative.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await page.getByText('This stock reminder changed. Refresh stock to see the latest alert.', { exact: true }).waitFor();
  assert.equal((await new DashboardService(pool, auth).get(actor.token)).negative[0].read, false);
  await page.getByRole('menuitem', { name: 'Product costs', exact: true }).click();
  await page.getByRole('button', { name: 'Load more costs', exact: true }).waitFor();
  assert.equal(await page.locator('.cost-table .el-table__row').count(), 100);
  await page.getByRole('button', { name: 'Load more costs', exact: true }).click();
  await page.locator('.cost-table .el-table__row').nth(100).waitFor();
  assert.equal(await page.locator('.cost-table .el-table__row').count(), 101);
  assert.equal(await page.getByRole('button', { name: 'Load more costs', exact: true }).count(), 0);
  const costRow = page.locator('.cost-table .el-table__row').filter({ hasText: 'Bolt A' });
  await costRow.getByText('RM -1.25', { exact: true }).waitFor();
  await costRow.getByText('RM 1.25', { exact: true }).waitFor();
  assert.equal(await page.locator('.cost-table input').count(), 0);
  const after = await catalog.detail(first.id);
  assert.equal(after.quantity, -1);
  const version = after.inventoryVersion;
  await page.getByRole('button', { name: 'Refresh costs', exact: true }).click();
  await page.getByRole('button', { name: 'Load more costs', exact: true }).waitFor();
  assert.equal(await page.locator('.cost-table .el-table__row').count(), 100);
  assert.equal((await catalog.detail(first.id)).inventoryVersion, version);
  assert.ok(before.inventoryVersion !== version);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login.locator('input[type=password]').waitFor();
  await login.locator('input[type=text]').fill('staff');
  await login.locator('input[type=password]').fill(password);
  await login.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('An Administrator account is required.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: 'Product costs', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('Built RuoYi costs: pagination, exact decimal values, read-only stock costs, negative reminder crossing protection and employee denial passed.');
} finally {
  if (browser) { await browser.browser.close(); await browser.cleanup(); }
  for (const instance of [proxy, server]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
