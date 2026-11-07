import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { testPool } from './helpers/database.mjs';
import { migrate } from '../src/db/database.mjs';
import { AuthService } from '../src/auth/service.mjs';
import { createAuthServer } from '../src/auth/http.mjs';
import { CatalogService, UNASSIGNED } from '../src/catalog/service.mjs';
import { createCatalogRoutes } from '../src/catalog/routes.mjs';
import { StockService } from '../src/stock/service.mjs';
import { createStockRoutes } from '../src/stock/routes.mjs';
import { createInventoryClient } from '../integrations/ruoyi-vue3/src/views/leet/inventory-api.mjs';

test('RuoYi history and quantity clients preserve manual anchors and reject stale or unauthorized writes', async t => {
  const { pool } = await testPool();
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.end();
  });
  await migrate(pool);
  const auth = new AuthService(pool), seed = new CatalogService(pool), catalog = new CatalogService(pool, auth), stock = new StockService(pool, auth);
  const password = randomUUID();
  await auth.bootstrap(password);
  const admin = await auth.login('CTL LEE', password);
  await auth.createEmployee({ username: 'history-worker', realName: 'Worker', password });
  const employee = await auth.login('history-worker', password);
  const category = await seed.addMaster('categories', { name: 'History category' });
  const input = { name: 'History bolt', categoryId: category.id, locationId: UNASSIGNED, individualCost: '1.25', minimumStock: 0, supplierIds: [] };
  const product = await seed.create(input);
  server = createAuthServer({
    auth, publicOrigin: 'https://warehouse.test',
    catalogRoutes: createCatalogRoutes({ auth, catalog }),
    stockRoutes: createStockRoutes({ stock }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = session => createInventoryClient({
    request: (path, options) => fetch('http://127.0.0.1:' + server.address().port + path, {
      ...options, headers: { ...options.headers, Origin: 'https://warehouse.test', ...(session && { Cookie: '__Host-warehouse_session=' + session.token }) },
    }),
  });
  const api = client(admin);
  await stock.commit(admin.token, admin.csrf, { requestId: randomUUID(), kind: 'inbound', items: [{ productId: product.id, quantity: 5 }] });
  const initial = await api.history(product.id);
  const event = initial.events[0];
  assert.ok(Date.parse(event.protectedUntil) > Date.parse(initial.serverTime));
  await api.correct(product.id, event.id, { quantity: '7', expectedRevision: event.revision });
  assert.equal((await api.detail(product.id)).quantity, 7);
  await assert.rejects(api.correct(product.id, event.id, { quantity: '9', expectedRevision: event.revision }), error => error.code === 'HISTORY_VERSION_CONFLICT');
  const before = await api.detail(product.id);
  const overwrite = { quantity: '20', expectedVersion: before.inventoryVersion };
  await api.overwrite(product.id, overwrite);
  const anchored = await api.detail(product.id);
  await assert.rejects(api.overwrite(product.id, overwrite), error => error.code === 'STOCK_VERSION_CONFLICT');
  assert.equal((await api.detail(product.id)).inventoryVersion, anchored.inventoryVersion);
  const afterOverwrite = await api.history(product.id);
  assert.equal(afterOverwrite.events.length, 1);
  await assert.rejects(api.correct(product.id, event.id, { quantity: '9', expectedRevision: afterOverwrite.events[0].revision }), error => error.code === 'CHECKPOINT_CONFLICT');
  const request = { requestId: randomUUID(), kind: 'inbound', items: [{ productId: product.id, quantity: 3 }] };
  await stock.commit(admin.token, admin.csrf, request);
  await stock.commit(admin.token, admin.csrf, request);
  assert.equal((await api.detail(product.id)).quantity, 23);
  const latest = await api.history(product.id, { kind: 'inbound' });
  assert.equal(latest.events.length, 2);
  assert.equal(latest.events[0].beforeQuantity, 20);
  assert.equal(latest.events[0].afterQuantity, 23);
  await assert.rejects(api.overwrite(product.id, { quantity: '1', expectedVersion: anchored.inventoryVersion }), error => error.code === 'STOCK_VERSION_CONFLICT');
  for (const quantity of ['-1', '1.5', '9007199254740992']) {
    await assert.rejects(api.overwrite(product.id, { quantity, expectedVersion: (await api.detail(product.id)).inventoryVersion }), error => error.code === 'INVALID_QUANTITY');
  }
  const staff = client(employee);
  await assert.rejects(staff.overwrite(product.id, { quantity: '1', expectedVersion: '0' }), /ADMIN_REQUIRED/);
  await assert.rejects(staff.correct(product.id, event.id, { quantity: '1', expectedRevision: '0' }), /ADMIN_REQUIRED/);
  assert.equal('individualCost' in await staff.detail(product.id), false);
  await assert.rejects(client(null).history(product.id), /LOGIN_REQUIRED/);
  const oldProduct = await seed.create({ ...input, name: 'Old history bolt' });
  await stock.commit(admin.token, admin.csrf, { requestId: randomUUID(), kind: 'inbound', items: [{ productId: oldProduct.id, quantity: 4 }] });
  await pool.query("UPDATE inventory_events SET created_at=clock_timestamp()-interval '169 hours' WHERE product_id=$1", [oldProduct.id]);
  const old = (await api.history(oldProduct.id)).events[0];
  await assert.rejects(api.correct(oldProduct.id, old.id, { quantity: '8', expectedRevision: old.revision }), error => error.code === 'HISTORY_IMMUTABLE');
  assert.equal((await api.detail(oldProduct.id)).quantity, 4);
  await pool.query("UPDATE inventory_events SET created_at=$2 WHERE product_id=$1", [oldProduct.id, '2026-01-01T00:30:00+08:00']);
  assert.equal((await api.history(oldProduct.id, { from: '2026-01-01T00:00:00+08:00', to: '2026-01-01T23:59:59.999+08:00' })).events.length, 1);
  assert.equal((await api.history(oldProduct.id, { from: '2025-12-31T00:00:00+08:00', to: '2025-12-31T23:59:59.999+08:00' })).events.length, 0);
  const paged = await seed.create({ ...input, name: 'Paged history bolt' });
  for (let index = 0; index < 32; index++) await stock.commit(admin.token, admin.csrf, { requestId: randomUUID(), kind: 'inbound', items: [{ productId: paged.id, quantity: 1 }] });
  const pageOne = await api.history(paged.id, { order: 'oldest' });
  const pageTwo = await api.history(paged.id, { order: 'oldest', cursor: pageOne.nextCursor });
  assert.equal(pageOne.events.length, 30);
  assert.equal(pageTwo.events.length, 2);
  assert.equal(new Set([...pageOne.events, ...pageTwo.events].map(row => row.id)).size, 32);
});
