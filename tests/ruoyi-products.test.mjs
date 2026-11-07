import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhotoStore } from '../src/catalog/files.mjs';
import { once } from 'node:events';
import { testPool } from './helpers/database.mjs';
import { migrate } from '../src/db/database.mjs';
import { AuthService } from '../src/auth/service.mjs';
import { createAuthServer } from '../src/auth/http.mjs';
import { CatalogService, UNASSIGNED } from '../src/catalog/service.mjs';
import { createCatalogRoutes } from '../src/catalog/routes.mjs';
import { createProductClient } from '../integrations/ruoyi-vue3/src/views/leet/product-api.mjs';

test('RuoYi product client preserves stock, rejects stale metadata and enforces employee permissions through actual routes', async t => {
  const { pool } = await testPool();
  t.after(() => pool.end());
  await migrate(pool);
  const directory = await mkdtemp(join(tmpdir(), 'leet-ruoyi-products-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new AuthService(pool), catalog = new CatalogService(pool, auth);
  const seed = new CatalogService(pool);
  const photos = new PhotoStore(pool, directory, auth);
  const password = randomUUID();
  await auth.bootstrap(password);
  const admin = await auth.login('CTL LEE', password);
  await auth.createEmployee({ username: 'staff', realName: 'Staff', password });
  const employee = await auth.login('staff', password);
  const category = await seed.addMaster('categories', { name: 'Fasteners' });
  const other = await seed.addMaster('categories', { name: 'Other' });
  const server = createAuthServer({ auth, publicOrigin: 'https://warehouse.test', catalogRoutes: createCatalogRoutes({ auth, catalog, photos }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = session => createProductClient({
    request: (path, options) => fetch('http://127.0.0.1:' + server.address().port + path, {
      ...options, headers: { ...options.headers, Origin: 'https://warehouse.test', ...(session && { Cookie: '__Host-warehouse_session=' + session.token }) },
    }),
  });
  const api = client(admin);
  const masters = await api.masters();
  assert.ok(masters.categories.some(row => row.id === category.id));
  assert.ok(masters.locations.some(row => row.id === UNASSIGNED));
  const input = { name: 'Bolt', categoryId: category.id, locationId: UNASSIGNED, individualCost: '1.25', minimumStock: 2, supplierIds: [], defaultSupplierId: null };
  const created = await api.save(null, input);
  const product = await api.detail(created.id);
  assert.equal(product.quantity, 0);
  assert.equal(product.individualCost, '1.25');
  assert.equal((await api.list({ categoryId: other.id })).products.length, 0);
  assert.equal((await api.list({ categoryId: category.id })).products[0].id, product.id);
  await api.save(product.id, { ...input, name: 'Changed', detailsVersion: product.detailsVersion });
  await assert.rejects(api.save(product.id, { ...input, name: 'Stale overwrite', detailsVersion: product.detailsVersion }), error => error.code === 'METADATA_VERSION_CONFLICT');
  assert.equal((await api.detail(product.id)).name, 'Changed');
  assert.equal((await api.detail(product.id)).quantity, 0);
  const staff = client(employee);
  assert.equal('individualCost' in await staff.detail(product.id), false);
  await assert.rejects(staff.save(product.id, input), /ADMIN_REQUIRED/);
  await assert.rejects(staff.remove(product.id), /ADMIN_REQUIRED/);
  await assert.rejects(client(null).list(), /LOGIN_REQUIRED/);
  await api.remove(product.id);
  await assert.rejects(api.detail(product.id), error => error.code === 'PRODUCT_NOT_FOUND');
});
