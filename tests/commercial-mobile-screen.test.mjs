import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchBrowser } from './helpers/browser.mjs';

test('mobile pairing screen guides camera recovery, discovery, and reopening at phone width', async t => {
  const root = new URL('../', import.meta.url);
  const html = await readFile(new URL('mobile/index.html', root), 'utf8');
  const harness = `
    import { mountPairingScreen } from '/mobile/pairing-screen.mjs';
    const origin = 'https://192.168.1.44:3443', serverId = '647aa912-4d20-4dac-b95d-6187772a20cb';
    const qr = origin + '/#pairing=' + encodeURIComponent(JSON.stringify({
      schema: 1, type: 'leet-local-pairing', origin, serverId, invitationId: '147aa912-4d20-4dac-b95d-6187772a20cb',
      token: 'a'.repeat(43), certificateFingerprint: 'ab'.repeat(32),
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    }));
    const administratorQr = origin + '/#warehouse=' + encodeURIComponent(JSON.stringify({
      schema: 1, origin, serverId, certificateFingerprint: 'ab'.repeat(32),
    }));
    window.fixture = { granted: false, scans: 0, settings: 0, opens: [] };
    mountPairingScreen({
      document, storage: localStorage, native: true,
      cameraAllowed: async () => fixture.granted,
      openSettings: async () => { fixture.settings++; },
      scan: async (_words, administrator) => {
        fixture.scans++;
        return { ScanResult: fixture.cancelled ? '' : administrator ? administratorQr : qr };
      },
      requestPinned: async ({ url, route }) => {
        if (!route) throw Error('Old IP');
        return { status: 200, url, data: { schema: 1, serverId } };
      },
      discover: () => new Promise(resolve => { fixture.resolveDiscovery = resolve; }),
      open: async options => fixture.opens.push(options),
    });
  `;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (path === '/mobile/') res.end(html);
      else if (path === '/mobile/app.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(harness);
      } else if (/^\/(?:mobile|public\/app)\/[a-z-]+\.(?:mjs|js|css)$/.test(path)) {
        res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(await readFile(new URL(path.slice(1), root)));
      } else { res.statusCode = 404; res.end(); }
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { browser, cleanup } = await launchBrowser();
  t.after(async () => { await browser.close(); await cleanup(); });
  const page = await browser.newPage({ viewport: { width: 320, height: 620 }, isMobile: true });
  await page.goto('http://127.0.0.1:' + server.address().port + '/mobile/');
  const scan = page.getByRole('button', { name: 'Scan employee pairing code' });
  await scan.click();
  await page.getByRole('status').getByText(/Camera access is off/).waitFor();
  await page.getByRole('button', { name: 'Open app settings' }).click();
  assert.equal(await page.evaluate(() => globalThis.fixture.settings), 1);
  assert.equal(await page.evaluate(() => globalThis.fixture.scans), 0);

  await page.evaluate(() => { globalThis.fixture.granted = true; globalThis.fixture.cancelled = true; });
  await scan.click();
  await page.getByText(/Scan cancelled/).waitFor();
  await page.evaluate(() => { globalThis.fixture.cancelled = false; });
  await scan.click();
  await page.getByText(/Looking for your warehouse/).waitFor();
  assert.equal(await scan.isDisabled(), true);
  await page.evaluate(() => globalThis.fixture.resolveDiscovery(['192.168.1.45']));
  await page.getByRole('button', { name: 'Open warehouse' }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.fixture.opens[0].route), '192.168.1.45');

  await page.getByRole('combobox').selectOption('ms');
  await page.getByRole('button', { name: 'Buka gudang' }).waitFor();
  await page.getByRole('combobox').selectOption('zh');
  await page.getByRole('button', { name: '打开仓库' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '打开仓库' }).click();
  await page.waitForFunction(() => globalThis.fixture.opens.length === 1);
  assert.equal(await page.evaluate(() => globalThis.fixture.scans), 0);
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);

  await page.evaluate(() => { globalThis.fixture.granted = true; });
  const administrator = page.getByRole('button', { name: '管理员登录' });
  await administrator.click();
  await page.getByText(/正在局域网寻找仓库/).waitFor();
  await page.evaluate(() => globalThis.fixture.resolveDiscovery(['192.168.1.46']));
  await page.getByRole('button', { name: '扫描新的管理员连接码' }).waitFor();
  const routes = await page.evaluate(() => ({
    employee: JSON.parse(localStorage.getItem('leet-verified-warehouse')).route,
    administrator: JSON.parse(localStorage.getItem('leet-verified-administrator-warehouse')).route,
  }));
  assert.deepEqual(routes, { employee: '192.168.1.45', administrator: '192.168.1.46' });
  await page.reload();
  await administrator.click();
  await page.waitForFunction(() => globalThis.fixture.opens.length === 1);
  assert.deepEqual(await page.evaluate(() => [globalThis.fixture.scans, globalThis.fixture.opens[0].route]), [0, '192.168.1.46']);
});
