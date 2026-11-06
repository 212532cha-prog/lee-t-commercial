import assert from 'node:assert/strict';
import test from 'node:test';
import { transaction } from '../src/db/database.mjs';
import { initializeActivationLedger, redeemActivationCode } from '../src/commercial/activation-ledger.mjs';
import {
  confirmLicensePayment, initializeLicenseManagement, issuePaidActivation, listLicenseAudit,
  listLicensePayments, registerLicenseCustomer,
} from '../src/commercial/license-management.mjs';
import { createDeviceRequest, generateIssuerKeyPair, verifyLicense } from '../src/commercial/license.mjs';
import { testPool } from './helpers/database.mjs';

const tables = [
  'lee_t_activation_codes', 'lee_t_activation_followups', 'lee_t_activation_successions',
  'lee_t_activation_audit', 'lee_t_customers', 'lee_t_management_payments', 'lee_t_management_audit',
];

test('issuer recovery preserves receipts, supersession, audit and device-bound redemption', async t => {
  const source = await testPool();
  t.after(() => source.pool.end());
  const target = await testPool();
  t.after(() => target.pool.end());
  for (const { pool } of [source, target]) {
    await initializeActivationLedger(pool);
    await initializeLicenseManagement(pool);
  }
  const operator = { id: 'recovery-test', role: 'issuer' };
  const issuer = { ...generateIssuerKeyPair(), keyId: 'recovery-key' };
  const device = createDeviceRequest({ device: { machineId: 'one', boardId: 'two', systemDiskId: 'three' } });
  const other = createDeviceRequest({ device: { machineId: 'four', boardId: 'five', systemDiskId: 'six' } });
  const { id: customerId } = await registerLicenseCustomer(source.pool, operator, { companyName: 'Recovery fixture' });
  const purchase = async (kind, version, extra = {}) => {
    const payment = await confirmLicensePayment(source.pool, operator, { customerId, receiptReference: 'receipt-' + kind, kind, version });
    return issuePaidActivation(source.pool, operator, { customerId, paymentId: payment.id, expiresAt: new Date(Date.now() + 120000), ...extra });
  };
  const initial = await purchase('initial', '1.0.0');
  const original = await redeemActivationCode(source.pool, { code: initial.code, request: device }, issuer);
  const upgraded = await purchase('upgrade', '2.0.0', { priorLicenseId: original.payload.licenseId, request: device });
  const upgradeLicense = await redeemActivationCode(source.pool, { code: upgraded.code, request: device }, issuer);
  const pending = await purchase('transfer', '2.0.0', { priorLicenseId: upgradeLicense.payload.licenseId, request: other });

  const snapshot = await transaction(source.pool, async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const result = [];
    for (const table of tables) {
      const { rows } = await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data FROM ${table} AS t`);
      result.push(JSON.stringify(rows[0].data));
    }
    return result;
  });
  assert.equal(snapshot.join('').includes(pending.code), false);
  await transaction(target.pool, async db => {
    for (const [index, table] of tables.entries()) {
      const identity = table === 'lee_t_activation_audit' ? ' OVERRIDING SYSTEM VALUE' : '';
      await db.query(`INSERT INTO ${table}${identity} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1)`, [snapshot[index]]);
    }
    await db.query("SELECT setval(pg_get_serial_sequence('lee_t_activation_audit','id'), (SELECT max(id) FROM lee_t_activation_audit))");
  });
  assert.deepEqual(await listLicensePayments(target.pool, operator, customerId), await listLicensePayments(source.pool, operator, customerId));
  assert.deepEqual(await listLicenseAudit(target.pool, operator, customerId), await listLicenseAudit(source.pool, operator, customerId));
  await assert.rejects(redeemActivationCode(target.pool, { code: initial.code, request: device }, issuer), { code: 'INVALID_ACTIVATION_CODE' });
  await assert.rejects(redeemActivationCode(target.pool, { code: pending.code, request: device }, issuer), { code: 'INVALID_ACTIVATION_CODE' });
  const restored = await redeemActivationCode(target.pool, { code: pending.code, request: other }, issuer);
  assert.equal(restored.payload.priorLicenseId, upgradeLicense.payload.licenseId);
  assert.equal(verifyLicense({ license: restored, request: other, publicKeyPem: issuer.publicKeyPem, runningVersion: '2.0.0' }).valid, true);
  assert.deepEqual(await redeemActivationCode(target.pool, { code: pending.code, request: other }, issuer), restored);
  assert.equal((await listLicensePayments(source.pool, operator, customerId)).find(row => row.kind === 'transfer').status, 'issued');
  assert.equal((await listLicensePayments(target.pool, operator, customerId)).find(row => row.kind === 'transfer').status, 'redeemed');
});
