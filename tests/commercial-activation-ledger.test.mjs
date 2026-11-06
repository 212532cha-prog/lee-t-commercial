import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialActivationCode, initializeActivationLedger, redeemInitialActivationCode } from '../src/commercial/activation-ledger.mjs';
import { createDeviceRequest, generateIssuerKeyPair, verifyLicense } from '../src/commercial/license.mjs';
import { testPool } from './helpers/database.mjs';

test('transactional initial activation is atomic across workers and retryable only by the same installation', async t => {
  const { pool } = await testPool();
  t.after(() => pool.end());
  await initializeActivationLedger(pool);
  const issuer = { ...generateIssuerKeyPair(), keyId: 'test-issuer' };
  const purchase = { customerId: 'first-customer', version: '1.0.0', expiresAt: new Date(Date.now() + 60_000) };
  await assert.rejects(createInitialActivationCode(pool, purchase), /Payment confirmation/);
  const code = await createInitialActivationCode(pool, { ...purchase, paid: true });
  const device = { machineId: 'machine-a', boardId: 'board-a', systemDiskId: 'disk-a' };
  const first = createDeviceRequest({ device });
  const second = createDeviceRequest({ device });
  await assert.rejects(redeemInitialActivationCode(pool, { code, request: {} }, issuer), { code: 'INVALID_ACTIVATION_CODE' });
  await assert.rejects(redeemInitialActivationCode(pool, { code, request: first }, { ...issuer, privateKeyPem: '' }));
  const contenders = await Promise.allSettled([
    redeemInitialActivationCode(pool, { code, request: first }, issuer),
    redeemInitialActivationCode(pool, { code, request: second }, issuer),
  ]);
  assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1);
  const [winner, loser] = contenders[0].status === 'fulfilled' ? [first, second] : [second, first];
  const original = contenders.find(result => result.status === 'fulfilled').value;
  assert.equal(original.payload.customerId, purchase.customerId);
  assert.equal(verifyLicense({ license: original, publicKeyPem: issuer.publicKeyPem, request: winner, runningVersion: purchase.version }).valid, true);
  assert.deepEqual(await redeemInitialActivationCode(pool, { code, request: winner }, issuer), original);
  await assert.rejects(redeemInitialActivationCode(pool, { code, request: loser }, issuer), { code: 'INVALID_ACTIVATION_CODE' });
  const rows = (await pool.query('SELECT code_hash, license FROM lee_t_activation_codes')).rows;
  assert.equal(rows.length, 1);
  assert.match(rows[0].code_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(rows).includes(code), false);
  assert.deepEqual((await pool.query('SELECT event FROM lee_t_activation_audit ORDER BY id')).rows, [{ event: 'issued' }, { event: 'redeemed' }]);
  await pool.query("UPDATE lee_t_activation_codes SET expires_at = now() - interval '1 second'");
  await assert.rejects(redeemInitialActivationCode(pool, { code, request: winner }, issuer), { code: 'INVALID_ACTIVATION_CODE' });
});
