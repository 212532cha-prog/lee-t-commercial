import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testPool } from '../tests/helpers/database.mjs';
import { initializeActivationLedger, createInitialActivationCode, redeemActivationCode } from '../src/commercial/activation-ledger.mjs';
import { generateIssuerKeyPair, createDeviceRequest, verifyLicense } from '../src/commercial/license.mjs';

if (process.env.WAREHOUSE_NATIVE_PG !== '1') throw Error('Native PostgreSQL is required.');
const { pool } = await testPool();
const directory = await mkdtemp(join(tmpdir(), 'offline-cli-'));
try {
  await initializeActivationLedger(pool);
  const { rows: [{ schema }] } = await pool.query('SELECT current_schema() AS schema');
  const databaseUrl = new URL('postgresql://localhost');
  databaseUrl.hostname = process.env.PGHOST;
  databaseUrl.port = process.env.PGPORT;
  databaseUrl.username = process.env.PGUSER;
  databaseUrl.password = process.env.PGPASSWORD;
  databaseUrl.pathname = '/' + process.env.PGDATABASE;
  databaseUrl.searchParams.set('options', '-c search_path=' + schema);
  const keys = generateIssuerKeyPair();
  const keyId = 'offline-test';
  const issuerKeyPath = join(directory, 'issuer.key');
  const config = join(directory, 'issuer.private.json');
  const file = join(directory, 'device.json');
  await writeFile(issuerKeyPath, keys.privateKeyPem, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ databaseUrl: databaseUrl.href, issuerKeyId: keyId, issuerKeyPath }), { mode: 0o600 });
  const device = { machineId: 'a', boardId: 'b', systemDiskId: 'c' };
  const request = createDeviceRequest({ device });
  const other = createDeviceRequest({ device });
  const code = await createInitialActivationCode(pool, {
    customerId: 'offline-test', version: '1.0.0', paid: true, expiresAt: new Date(Date.now() + 120000),
  });
  const run = () => spawnSync(process.execPath, ['scripts/sign-offline-license.mjs', file], {
    input: code + '\n', env: { ...process.env, LEE_T_ACTIVATION_SERVICE_CONFIG: config }, encoding: 'utf8', timeout: 10000,
  });
  await writeFile(file, JSON.stringify(request));
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const license = JSON.parse(first.stdout);
  assert.equal(verifyLicense({ license, request, publicKeyPem: keys.publicKeyPem, runningVersion: '1.0.0' }).valid, true);
  const retry = run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.stdout, first.stdout);
  assert.deepEqual(await redeemActivationCode(pool, { code, request }, { ...keys, keyId }), license);
  await writeFile(file, JSON.stringify(other));
  const denied = run();
  assert.equal(denied.status, 1);
  assert.equal(denied.stdout, '');
  assert.ok(!denied.stderr.includes(code));
  console.log('Offline issuer CLI passed signature verification, exact retry, shared redemption ledger and wrong-device rejection.');
} finally {
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
