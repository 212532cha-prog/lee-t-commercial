import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateOnline, activationPath } from '../src/commercial/activation-client.mjs';
import { createActivationServer } from '../src/commercial/activation-http.mjs';
import { createInitialActivationCode, initializeActivationLedger } from '../src/commercial/activation-ledger.mjs';
import { generateIssuerKeyPair } from '../src/commercial/license.mjs';
import { requireLocalLicense } from '../src/commercial/server-license.mjs';
import { testPool } from './helpers/database.mjs';

test('online activation uses trusted HTTPS, stores a signed license and can then verify it offline', async t => {
  const { pool } = await testPool();
  const directory = await mkdtemp(join(tmpdir(), 'lee-t-activation-http-'));
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
  const tlsKey = join(directory, 'tls-key.pem');
  const tlsCert = join(directory, 'tls-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tlsKey, '-out', tlsCert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = await readFile(tlsCert);
  const issuer = { ...generateIssuerKeyPair(), keyId: 'test-issuer' };
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
  const code = await createInitialActivationCode(pool, {
    customerId: 'customer-online', version, paid: true, expiresAt: new Date(Date.now() + 60000),
  });
  server = createActivationServer({ tls: { key: await readFile(tlsKey), cert }, pool, issuer });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const settings = {
    LEE_T_ACTIVATION_ORIGIN: `https://127.0.0.1:${server.address().port}`,
    LEE_T_LICENSE_DIR: join(directory, 'activation'),
    LEE_T_ISSUER_PUBLIC_KEY_PATH: join(directory, 'issuer.pem'),
    LEE_T_ISSUER_KEY_ID: issuer.keyId,
  };
  await writeFile(settings.LEE_T_ISSUER_PUBLIC_KEY_PATH, issuer.publicKeyPem);
  const readDevice = async () => ({ machineId: 'machine-a', boardId: 'board-a', systemDiskId: 'disk-a' });
  const send = (url, options = {}) => new Promise((resolve, reject) => {
    const req = request(url, { ...options, ca: cert }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });

  await assert.rejects(activateOnline({ ...settings, LEE_T_ACTIVATION_ORIGIN: 'http://127.0.0.1' }, code, { readDevice }), /HTTPS origin/);
  await assert.rejects(activateOnline(settings, code, { readDevice }), error => error.cause?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
  const endpoint = new URL(activationPath, settings.LEE_T_ACTIVATION_ORIGIN);
  assert.equal((await send(endpoint)).status, 405);
  const post = body => send(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('x'.repeat(4097))).status, 413);
  const options = { readDevice, send };
  const installed = await activateOnline(settings, code, options);
  assert.deepEqual(await activateOnline(settings, code, options), installed);
  await assert.rejects(activateOnline({ ...settings, LEE_T_LICENSE_DIR: join(directory, 'other') }, code, options), /HTTP 403/);

  await new Promise(resolve => server.close(resolve));
  assert.deepEqual(await requireLocalLicense(settings, { readDevice }), installed);
});
