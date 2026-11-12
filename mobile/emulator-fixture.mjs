import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testPool } from '../tests/helpers/database.mjs';
import { migrate } from '../src/db/database.mjs';
import { createAuthServer } from '../src/auth/http.mjs';
import { AuthService } from '../src/auth/service.mjs';
import { EmployeePairing } from '../src/commercial/employee-pairing.mjs';
import { CatalogService, UNASSIGNED } from '../src/catalog/service.mjs';
import { PhotoStore } from '../src/catalog/files.mjs';
import { createCatalogRoutes } from '../src/catalog/routes.mjs';
import { StockService } from '../src/stock/service.mjs';
import { createStockRoutes } from '../src/stock/routes.mjs';
import { CountService } from '../src/count/service.mjs';
import { createCountRoutes } from '../src/count/routes.mjs';
import { BackupService } from '../src/backup/service.mjs';
import { createBackupRoutes } from '../src/backup/routes.mjs';
import { DashboardService } from '../src/dashboard/service.mjs';
import { ProfileService } from '../src/profile/service.mjs';
import { ExportService } from '../src/export/service.mjs';
import { createApplicationRoutes } from '../src/dashboard/routes.mjs';

// Isolated test-only server. No control route is added to production.
export async function createEmulatorFixture() {
  const root = await mkdtemp(join(tmpdir(), 'leet-emulator-'));
  const { pool, engine } = await testPool();
  let server, exporter, backup;
  const close = async () => {
    if (server?.listening) {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await exporter?.tail;
    await backup?.waitForIdle();
    await pool.end();
    await rm(root, { recursive: true, force: true });
  };
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=warehouse.example', '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'subjectAltName=DNS:warehouse.example', '-keyout', 'key.pem', '-out', 'cert.pem'], { cwd: root, stdio: 'ignore' });
    const cert = await readFile(join(root, 'cert.pem')), key = await readFile(join(root, 'key.pem'));
    const pin = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
    const origin = 'https://warehouse.example:13443', control = randomUUID();
    await migrate(pool);
    const pairing = new EmployeePairing({ origin, serverId: randomUUID(), certificateFingerprint: pin });
    const auth = new AuthService(pool, { pairing });
    const password = randomUUID();
    await auth.bootstrap(password);
    const administrator = await auth.login('CTL LEE', password);
    const employee = await auth.createEmployee({ username: 'phone employee', realName: 'Phone employee', password });
    const data = join(root, 'data'); await mkdir(data);
    const catalog = new CatalogService(pool, auth);
    const context = { raw: administrator.token, csrf: administrator.csrf };
    const category = await catalog.addMaster('categories', { name: 'Phone tests' }, context);
    const product = await catalog.create({ name: 'Phone bolt', categoryId: category.id, locationId: UNASSIGNED, individualCost: '1.25', minimumStock: 5, supplierIds: [] }, context);
    const detail = await catalog.detail(product.id);
    assert.match(detail.qrToken, /^whp1_[A-Za-z0-9_-]{32}$/);
    const photos = new PhotoStore(pool, join(data, 'product-photos'), auth);
    const stock = new StockService(pool, auth), count = new CountService(pool, auth);
    backup = new BackupService(pool, auth, data);
    const dashboard = new DashboardService(pool, auth), profile = new ProfileService(pool, auth, data);
    exporter = new ExportService(pool, auth, data);
    server = createAuthServer({ auth, publicOrigin: origin, tls: { cert, key },
      catalogRoutes: createCatalogRoutes({ auth, catalog, photos, exporter }), stockRoutes: createStockRoutes({ stock }),
      countRoutes: createCountRoutes({ auth, count, photos }), backupRoutes: createBackupRoutes({ backup }),
      applicationRoutes: createApplicationRoutes({ auth, dashboard, profile, exports: exporter }),
    });
    const handler = server.listeners('request')[0]; server.removeAllListeners('request');
    let offline = false;
    server.on('request', (req, res) => {
      const url = new URL(req.url, origin);
      if (url.pathname === '/api/test-control' && url.searchParams.get('token') === control) {
        if (url.searchParams.has('offline')) offline = url.searchParams.get('offline') === '1';
        // A fresh invitation is issued at the point of use, never by extending expiry.
        if (url.searchParams.has('invitation')) {
          pairing.manage(auth, { raw: administrator.token, csrf: administrator.csrf }, employee.id, 'invite')
            .then(value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); })
            .catch(() => { res.statusCode = 500; res.end('{}'); });
        } else { res.end(JSON.stringify({ ok: true })); }
      } else if (offline && url.pathname.startsWith('/api/')) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"INTERNAL_ERROR"}'); }
      else handler(req, res);
    });
    await new Promise(resolve => server.listen(13443, '0.0.0.0', resolve));
    console.log('Android fixture database: ' + engine);
    return { close, arguments: { origin, pin, password, control, product: product.id, token: detail.qrToken,
      employee: employee.id, serverId: pairing.serverId } };
  } catch (error) { await close(); throw error; }
}
