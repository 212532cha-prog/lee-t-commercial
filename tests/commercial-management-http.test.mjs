import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashPassword } from '../src/auth/service.mjs';
import { initializeActivationLedger } from '../src/commercial/activation-ledger.mjs';
import { initializeLicenseManagement } from '../src/commercial/license-management.mjs';
import { createManagementServer } from '../src/commercial/management-http.mjs';
import { testPool } from './helpers/database.mjs';

test('real TLS management requires trusted client certificate, matched password, scope and issuer role', async t => {
  const { pool } = await testPool();
  const directory = await mkdtemp(join(tmpdir(), 'leet-management-'));
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });
  await initializeActivationLedger(pool);
  await initializeLicenseManagement(pool);
  const openssl = (...args) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem',
    '-days', '1', '-subj', '/CN=Lee T Test CA');
  const ca = await readFile(join(directory, 'ca.pem'));
  async function certificate(name, use, extensions = '') {
    await writeFile(join(directory, name + '.cnf'), 'extendedKeyUsage=' + use + '\n' + extensions);
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + name);
    openssl('x509', '-req', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-days', '1', '-extfile', name + '.cnf', '-out', name + '.pem');
    return { key: await readFile(join(directory, name + '.key')), cert: await readFile(join(directory, name + '.pem')) };
  }
  const host = await certificate('localhost', 'serverAuth', 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  const sales = await certificate('sales-test', 'clientAuth');
  const issuer = await certificate('issuer-test', 'clientAuth');
  const unlisted = await certificate('unlisted-test', 'clientAuth');
  const secret = 'test-only';
  const passwordHash = await hashPassword(secret);
  const operator = (id, role, tls) => ({ id, role, fingerprint: new X509Certificate(tls.cert).fingerprint256, passwordHash });
  const origin = 'https://localhost';
  server = createManagementServer({ tls: { ...host, ca }, pool, origin, operators: [
    operator('sales-test', 'sales', sales), operator('issuer-test', 'issuer', issuer),
  ] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const call = (path, { tls = sales, login = 'sales-test:' + secret, data, source = origin } = {}) => new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: server.address().port, path, ca, ...tls,
      method: data ? 'POST' : 'GET', agent: false,
      headers: {
        ...(login ? { Authorization: 'Basic ' + Buffer.from(login).toString('base64') } : {}),
        ...(data ? { Origin: source, 'Content-Type': 'application/json' } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, body: res.headers['content-type'].includes('application/json') ? JSON.parse(raw) : raw });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data ? JSON.stringify(data) : undefined);
  });
  await assert.rejects(call('/', { tls: {} }));
  assert.equal((await call('/', { tls: unlisted })).status, 403);
  assert.equal((await call('/', { login: '' })).status, 401);
  assert.equal((await call('/', { login: 'sales-test:incorrect' })).status, 401);
  assert.equal((await call('/', { login: 'issuer-test:' + secret })).status, 401);
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /Lee T License Center/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal((await call('/management.js')).status, 200);
  assert.equal((await call('/api/customers', { data: { companyName: 'Blocked' }, source: 'https://untrusted.test' })).status, 403);
  const customer = await call('/api/customers', { data: { companyName: 'Customer' } });
  assert.equal(customer.status, 201);
  const customerId = customer.body.id;
  const payment = await call('/api/payments', { data: { customerId, receiptReference: 'receipt-api', kind: 'initial', version: '1.0.0' } });
  assert.equal(payment.status, 201);
  const data = { customerId, paymentId: payment.body.id, expiresAt: new Date(Date.now() + 60000), role: 'issuer' };
  assert.equal((await call('/api/issue', { data })).status, 403);
  const issuance = await call('/api/issue', { data, tls: issuer, login: 'issuer-test:' + secret });
  assert.equal(issuance.status, 201);
  assert.match(issuance.body.code, /^LT-[\w-]{32}$/);
  assert.equal((await call('/api/issue', { data, tls: issuer, login: 'issuer-test:' + secret })).status, 409);
  const audit = await call('/api/audit?customerId=' + customerId);
  assert.equal(audit.body.some(row => row.actor === 'issuer-test' && row.action === 'code_issued'), true);
  assert.equal(JSON.stringify(audit.body).includes(issuance.body.code), false);
});
