import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { initializeActivationLedger, redeemActivationCode } from '../src/commercial/activation-ledger.mjs';
import { createDeviceRequest, generateIssuerKeyPair } from '../src/commercial/license.mjs';
import {
  confirmLicensePayment, initializeLicenseManagement, issuePaidActivation, listLicensePayments, registerLicenseCustomer,
} from '../src/commercial/license-management.mjs';
import { testPool } from './helpers/database.mjs';

test('confirmed receipts are isolated by customer and allow one concurrent issuance with a complete audit', async t => {
  const { pool } = await testPool();
  t.after(() => pool.end());
  await initializeActivationLedger(pool);
  await initializeLicenseManagement(pool);
  const sales = { id: 'sales-a', role: 'sales' };
  const issuer = { id: 'issuer-a', role: 'issuer' };
  await assert.rejects(registerLicenseCustomer(pool, { id: 'outsider', role: 'employee' }, { companyName: 'Blocked' }), /Operator access/);
  const first = await registerLicenseCustomer(pool, sales, { companyName: 'Customer A' });
  const second = await registerLicenseCustomer(pool, sales, { companyName: 'Customer B' });
  const scoped = { ...issuer, customerId: first.id };
  const purchase = { customerId: first.id, receiptReference: 'receipt-one', kind: 'initial', version: '1.0.0' };
  await assert.rejects(confirmLicensePayment(pool, scoped, { ...purchase, customerId: second.id }), /Customer access denied/);
  const payment = await confirmLicensePayment(pool, sales, purchase);
  await assert.rejects(confirmLicensePayment(pool, sales, { ...purchase, customerId: second.id }), { code: '23505' });
  const issuance = { customerId: first.id, paymentId: payment.id, expiresAt: new Date(Date.now() + 60_000) };
  await assert.rejects(issuePaidActivation(pool, sales, issuance), /Issuer role/);
  await assert.rejects(issuePaidActivation(pool, issuer, { ...issuance, customerId: second.id }), /Confirmed payment/);
  await assert.rejects(issuePaidActivation(pool, issuer, { ...issuance, paymentId: randomUUID() }), /Confirmed payment/);
  await assert.rejects(listLicensePayments(pool, scoped, second.id), /Customer access denied/);
  const results = await Promise.allSettled([issuePaidActivation(pool, scoped, issuance), issuePaidActivation(pool, scoped, issuance)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /already has an activation code/);
  const { code } = results.find(result => result.status === 'fulfilled').value;
  const before = await listLicensePayments(pool, scoped, first.id);
  assert.equal(before[0].status, 'issued');
  assert.equal(JSON.stringify(before).includes(code), false);
  await pool.query("UPDATE lee_t_activation_codes SET expires_at=now()-interval '1 second'");
  const replacement = await issuePaidActivation(pool, scoped, issuance);
  assert.notEqual(replacement.code, code);
  const request = createDeviceRequest({ device: { machineId: 'one', boardId: 'two', systemDiskId: 'three' } });
  const keys = { ...generateIssuerKeyPair(), keyId: 'management-test' };
  await assert.rejects(redeemActivationCode(pool, { code, request }, keys), { code: 'INVALID_ACTIVATION_CODE' });
  const license = await redeemActivationCode(pool, { code: replacement.code, request }, keys);
  assert.equal(license.payload.customerId, first.id);
  assert.equal(license.payload.entitledVersion, purchase.version);
  assert.equal((await listLicensePayments(pool, scoped, first.id))[0].status, 'redeemed');
  await assert.rejects(issuePaidActivation(pool, scoped, issuance), /already has an activation code/);

  const followup = await confirmLicensePayment(pool, sales, {
    ...purchase, receiptReference: 'receipt-two', kind: 'upgrade', version: '2.0.0',
  });
  const upgradeInput = { ...issuance, paymentId: followup.id, priorLicenseId: license.payload.licenseId };
  await assert.rejects(issuePaidActivation(pool, issuer, { ...upgradeInput, request: {} }), /invalid activation request/);
  assert.equal((await listLicensePayments(pool, issuer, first.id)).find(row => row.id === followup.id).status, 'confirmed');
  const upgrade = await issuePaidActivation(pool, issuer, { ...upgradeInput, request });
  assert.equal((await redeemActivationCode(pool, { code: upgrade.code, request }, keys)).payload.entitledVersion, '2.0.0');

  const audit = (await pool.query('SELECT action,actor FROM lee_t_management_audit WHERE customer_id=$1', [first.id])).rows;
  assert.equal(audit.filter(row => row.action === 'payment_confirmed' && row.actor === sales.id).length, 2);
  assert.equal(audit.filter(row => row.action === 'code_issued' && row.actor === issuer.id).length, 2);
  assert.equal(audit.filter(row => row.action === 'code_reissued' && row.actor === issuer.id).length, 1);
});
