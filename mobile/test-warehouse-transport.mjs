import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer as reservePort } from 'node:net';
import { createInterface } from 'node:readline';
import { testPool } from '../tests/helpers/database.mjs';
import { migrate } from '../src/db/database.mjs';
import { createAuthServer } from '../src/auth/http.mjs';
import { AuthService } from '../src/auth/service.mjs';
import { EmployeePairing } from '../src/commercial/employee-pairing.mjs';
import { CatalogService, UNASSIGNED } from '../src/catalog/service.mjs';
import { StockService } from '../src/stock/service.mjs';
import { createStockRoutes } from '../src/stock/routes.mjs';
import { CountService } from '../src/count/service.mjs';
import { createCountRoutes } from '../src/count/routes.mjs';

export async function testWarehouseTransport({ classesDirectory, cert, key, pin }) {
  const { pool, engine } = await testPool();
  let server, reserved, client, lines, closed;
  try {
    reserved = reservePort();
    reserved.listen(0, '127.0.0.1');
    await once(reserved, 'listening');
    const port = reserved.address().port;
    const origin = 'https://warehouse.example:' + port;
    await migrate(pool);
    const pairing = new EmployeePairing({ origin, serverId: randomUUID(), certificateFingerprint: pin });
    const auth = new AuthService(pool, { pairing });
    const adminPassword = randomUUID(), password = randomUUID();
    await auth.bootstrap(adminPassword);
    const admin = await auth.login('CTL LEE', adminPassword);
    const { id } = await auth.createEmployee({ username: 'test employee', realName: '测试员工', password });
    const invitation = await pairing.manage(auth, { raw: admin.token, csrf: admin.csrf }, id, 'invite');
    const catalog = new CatalogService(pool);
    const category = await catalog.addMaster('categories', { name: 'Parts' });
    const product = await catalog.create({
      name: 'Fixture', categoryId: category.id, locationId: UNASSIGNED, individualCost: '1.50',
      minimumStock: 0, supplierIds: [],
    });
    const stock = new StockService(pool, auth);
    const count = new CountService(pool, auth);
    server = createAuthServer({
      auth, publicOrigin: origin, tls: { cert, key },
      stockRoutes: createStockRoutes({ stock }), countRoutes: createCountRoutes({ auth, count }),
    });
    await new Promise(resolve => reserved.close(resolve));
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    client = spawn('java', ['-Dsun.net.http.allowRestrictedHeaders=true', '-cp', classesDirectory, 'my.leet.warehouse.ProbeHarness', origin, pin, 'warehouse'],
      { stdio: ['pipe', 'pipe', 'inherit'], timeout: 25000 });
    closed = once(client, 'exit');
    lines = createInterface({ input: client.stdout });
    const responses = lines[Symbol.asyncIterator]();
    const request = async (method, path = '', { body, csrf = '', status = 200 } = {}) => {
      const payload = body === undefined ? '' : Buffer.from(JSON.stringify(body)).toString('base64');
      client.stdin.write([method, path, payload, csrf].join('\t') + '\n');
      const response = await responses.next();
      assert.equal(response.done, false, 'Java transport did not return a response');
      const separator = response.value.indexOf(':');
      const data = JSON.parse(response.value.slice(separator + 1));
      assert.equal(Number(response.value.slice(0, separator)), status, data.error ?? path);
      return data;
    };

    const login = '/api/auth/login';
    const credentials = { username: 'test employee', password };
    assert.equal((await request('POST', login, { body: credentials, status: 403 })).error, 'EMPLOYEE_PAIRING_REQUIRED');
    const signedIn = await request('POST', login, { body: { ...credentials, invitation } });
    assert.equal(signedIn.user.id, id);
    assert.equal((await request('GET', '/api/me')).user.realName, '测试员工');
    await request('REOPEN');
    assert.equal((await request('GET', '/api/me', { status: 401 })).error, 'UNAUTHENTICATED');
    const { csrf } = await request('POST', login, { body: credentials });
    const move = (kind, quantity) => ({
      requestId: randomUUID(), kind, items: [{ productId: product.id, quantity }],
    });
    const inbound = move('inbound', 3);
    const commit = body => request('POST', '/api/stock/transactions', { csrf, body });
    assert.deepEqual(await commit(inbound), await commit(inbound));
    await commit(move('outbound', 1));
    assert.equal((await catalog.detail(product.id)).quantity, 2);

    const task = await count.publish(admin.token, admin.csrf, { title: 'Transport test', scope: 'all' });
    const taskPath = '/api/count/tasks/' + task.id;
    await request('POST', taskPath + '/accept', { csrf, body: {} });
    const round = await request('POST', taskPath + '/begin', { csrf, body: {} });
    assert.equal((await request('EVENTS', taskPath + '/events?' + new URLSearchParams(round))).ready, true);
    const input = { ...round, requestId: randomUUID(), items: [{ productId: product.id, quantity: 1 }] };
    const report = await request('POST', taskPath + '/submit', { csrf, body: input });
    await request('CLOSE');
    const detail = await count.report(admin.token, report.reportId);
    assert.equal(detail.items[0].difference, -1);
    assert.equal((await catalog.detail(product.id)).quantity, 2);
    await pairing.manage(auth, { raw: admin.token, csrf: admin.csrf }, id, 'unbind');
    await request('GET', '/api/me', { status: 401 });
    client.stdin.end();
    assert.equal((await closed)[0], 0);
    console.log('Pinned Java transport passed real warehouse pairing, sign-in, re-open, stock and live count routes (' + engine + ').');
  } finally {
    lines?.close();
    if (client?.exitCode === null) client.kill();
    if (closed) await closed;
    if (reserved?.listening) await new Promise(resolve => reserved.close(resolve));
    if (server?.listening) {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await pool.end();
  }
}
