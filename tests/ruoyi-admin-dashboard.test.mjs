import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthServer } from '../src/auth/http.mjs';
import { AuthError } from '../src/auth/service.mjs';
import { loadWarehouseDashboard } from '../integrations/ruoyi-vue3/src/views/leet/warehouse-api.mjs';

test('RuoYi warehouse view uses the existing session and rejects employee and anonymous dashboards', async t => {
  const admin = { role: 'admin', statistics: { totalValue: '9007199254740993.01' }, negative: [], low: [] };
  const server = createAuthServer({
    auth: {}, publicOrigin: 'https://warehouse.test',
    applicationRoutes: ({ path, raw, json, res }) => {
      if (path !== '/api/dashboard') return false;
      if (!raw) throw new AuthError('UNAUTHENTICATED', 401);
      json(res, 200, raw === 'admin-session' ? admin : { role: 'employee', actions: ['products'] });
      return true;
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = session => (path, options) => {
    assert.equal(path, '/api/dashboard');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    return fetch('http://127.0.0.1:' + server.address().port + path, {
      ...options, headers: { ...options.headers, ...(session && { Cookie: '__Host-warehouse_session=' + session }) },
    });
  };
  assert.deepEqual(await loadWarehouseDashboard({ request: request('admin-session') }), admin);
  await assert.rejects(loadWarehouseDashboard({ request: request('employee-session') }), /ADMIN_REQUIRED/);
  await assert.rejects(loadWarehouseDashboard({ request: request() }), /LOGIN_REQUIRED/);
});

test('configured RuoYi assets are served on the same origin and other files are inaccessible', async t => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'leet-ruoyi-static-'));
  await mkdir(join(directory, 'static/js'), { recursive: true });
  await writeFile(join(directory, 'index.html'), '<title>Warehouse</title>');
  await writeFile(join(directory, 'static/js/app-test.js'), 'export {};');
  await writeFile(join(directory, 'private.json'), 'not public');
  const server = createAuthServer({ auth: {}, publicOrigin: 'https://warehouse.test', ruoyiAdminDirectory: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(base + '/admin/');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<title>Warehouse</title>');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const asset = await fetch(base + '/admin/static/js/app-test.js', { method: 'HEAD' });
  assert.match(asset.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await asset.text(), '');
  for (const path of ['/admin/private.json', '/admin/static/js/%2e%2e/%2e%2e/private.json']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.equal((await fetch(base + '/')).status, 200);
});
