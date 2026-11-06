import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFollowupActivationCode, createInitialActivationCode, initializeActivationLedger,
  redeemActivationCode, redeemInitialActivationCode,
} from '../src/commercial/activation-ledger.mjs';
import { createDeviceRequest, generateIssuerKeyPair, verifyLicense } from '../src/commercial/license.mjs';
import { testPool } from './helpers/database.mjs';

test('paid approvals bind upgrades to the same server and transfers to the approved replacement', async t => {
  const { pool } = await testPool();
  t.after(() => pool.end());
  await initializeActivationLedger(pool);
  const issuer = { ...generateIssuerKeyPair(), keyId: 'test-issuer' };
  const expiresAt = new Date(Date.now() + 120_000);
  const customerId = 'customer-a';
  const paid = true;
  const originalDevice = { machineId: 'machine-a', boardId: 'board-a', systemDiskId: 'disk-a' };
  const original = createDeviceRequest({ device: originalDevice });
  const changedDisk = createDeviceRequest({ device: { ...originalDevice, systemDiskId: 'disk-b' }, installationId: original.installationId });
  const replacement = createDeviceRequest({ device: { machineId: 'machine-b', boardId: 'board-b', systemDiskId: 'disk-c' } });
  const initialCode = await createInitialActivationCode(pool, { customerId, version: '1.0.0', expiresAt, paid });
  const redeem = (code, request, keys = issuer) => redeemActivationCode(pool, { code, request }, keys);
  const initial = await redeem(initialCode, original);
  const upgrade = {
    customerId, priorLicenseId: initial.payload.licenseId, kind: 'upgrade', version: '1.1.0',
    expiresAt, request: changedDisk, paid, paymentReference: 'receipt-a', approvedBy: 'operator-a',
  };
  const approve = input => createFollowupActivationCode(pool, input);
  await assert.rejects(approve({ ...upgrade, paid: false }), /Payment confirmation/);
  await assert.rejects(approve({ ...upgrade, approvedBy: '' }), /operator approval/);
  await assert.rejects(approve({ ...upgrade, customerId: 'customer-b' }), /active prior license/);
  await assert.rejects(approve({ ...upgrade, version: '1.0.0' }), /target version/);
  await assert.rejects(approve({ ...upgrade, request: replacement }), /current installation/);
  const approvals = await Promise.allSettled([
    approve(upgrade),
    approve({ ...upgrade, paymentReference: 'receipt-b' }),
  ]);
  assert.equal(approvals.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(approvals.find(result => result.status === 'rejected').reason.message, /already pending/);
  const originalCode = approvals.find(result => result.status === 'fulfilled').value;
  const [{ payment_reference: winningReference }] = (await pool.query('SELECT payment_reference FROM lee_t_activation_followups')).rows;
  await pool.query("UPDATE lee_t_activation_codes SET expires_at = now() - interval '1 second' WHERE license IS NULL");
  await assert.rejects(approve({ ...upgrade, version: '1.2.0', paymentReference: winningReference }), /already associated/);
  const code = await approve({ ...upgrade, paymentReference: winningReference });
  await assert.rejects(redeem(originalCode, changedDisk), { code: 'INVALID_ACTIVATION_CODE' });
  await assert.rejects(redeemInitialActivationCode(pool, { code, request: changedDisk }, issuer), { code: 'INVALID_ACTIVATION_CODE' });
  await assert.rejects(redeem(code, original), { code: 'INVALID_ACTIVATION_CODE' });
  await assert.rejects(redeem(code, replacement), { code: 'INVALID_ACTIVATION_CODE' });
  await assert.rejects(redeem(code, changedDisk, { ...issuer, privateKeyPem: '' }));
  assert.deepEqual(await redeem(initialCode, original), initial);
  const [upgraded, retried] = await Promise.all([redeem(code, changedDisk), redeem(code, changedDisk)]);
  assert.deepEqual(upgraded, retried);
  assert.equal(upgraded.payload.kind, 'upgrade');
  assert.equal(upgraded.payload.priorLicenseId, initial.payload.licenseId);
  assert.equal(upgraded.payload.entitledVersion, '1.1.0');
  await assert.rejects(redeem(initialCode, original), { code: 'INVALID_ACTIVATION_CODE' });
  await assert.rejects(approve(upgrade), /active prior license/);

  const transfer = {
    ...upgrade, priorLicenseId: upgraded.payload.licenseId, kind: 'transfer', version: '2.0.0',
    request: replacement, paymentReference: 'receipt-c',
  };
  await assert.rejects(approve({ ...transfer, request: changedDisk }), /different server/);
  await assert.rejects(approve({ ...transfer, version: '1.0.0' }), /target version/);
  const transferCode = await approve(transfer);
  const transferred = await redeem(transferCode, replacement);
  assert.equal(transferred.payload.kind, 'transfer');
  assert.equal(transferred.payload.priorLicenseId, upgraded.payload.licenseId);
  assert.equal(transferred.payload.customerId, customerId);
  assert.equal(verifyLicense({ license: transferred, publicKeyPem: issuer.publicKeyPem, request: replacement, runningVersion: '2.0.0' }).valid, true);
  assert.equal(verifyLicense({ license: transferred, publicKeyPem: issuer.publicKeyPem, request: changedDisk, runningVersion: '2.0.0' }).valid, false);
  await assert.rejects(redeem(code, changedDisk), { code: 'INVALID_ACTIVATION_CODE' });
  assert.deepEqual(await redeem(transferCode, replacement), transferred);
  const approvalsRecorded = (await pool.query('SELECT kind, approved_by FROM lee_t_activation_followups WHERE replaced_at IS NULL ORDER BY kind')).rows;
  assert.deepEqual(approvalsRecorded, [{ kind: 'transfer', approved_by: 'operator-a' }, { kind: 'upgrade', approved_by: 'operator-a' }]);
  assert.equal((await pool.query('SELECT * FROM lee_t_activation_successions')).rows.length, 2);
  assert.equal((await pool.query('SELECT * FROM lee_t_activation_audit')).rows.length, 7);
});
