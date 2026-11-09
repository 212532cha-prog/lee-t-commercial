import assert from 'node:assert/strict';
import pg from 'pg';
import { provisionIssuer, issuerSchema, managementRole, redemptionRole } from '../integrations/license-center/provision.mjs';
import { redeemActivationCode } from '../src/commercial/activation-ledger.mjs';
import { createDeviceRequest, generateIssuerKeyPair, verifyLicense } from '../src/commercial/license.mjs';
import { confirmLicensePayment, issuePaidActivation, registerLicenseCustomer } from '../src/commercial/license-management.mjs';

if (process.env.WAREHOUSE_NATIVE_PG !== '1' || !process.env.PGDATABASE?.endsWith('_test')) {
  throw Error('Dedicated native PostgreSQL test database required.');
}
const owner = new pg.Pool();
const manager = new pg.Pool({ options: `-c role=${managementRole} -c search_path=${issuerSchema},pg_catalog` });
const redeemer = new pg.Pool({ options: `-c role=${redemptionRole} -c search_path=${issuerSchema},pg_catalog` });
const outsiderRole = 'lee_t_provision_test_outsider';
const outsider = new pg.Pool({ options: `-c role=${outsiderRole}` });
let provisioned = false;
let outsiderCreated = false;
try {
  await provisionIssuer(owner);
  provisioned = true;
  await assert.rejects(provisionIssuer(owner), /ISSUER_PROVISIONING_REQUIRES_FRESH_DATABASE/);
  const issuer = { id: 'test-operator', role: 'issuer' };
  const customer = await registerLicenseCustomer(manager, issuer, { companyName: 'Isolated test customer' });
  const payment = await confirmLicensePayment(manager, issuer, {
    customerId: customer.id, receiptReference: 'provision-test', kind: 'initial', version: '0.8.5',
  });
  const { code } = await issuePaidActivation(manager, issuer, {
    customerId: customer.id, paymentId: payment.id, expiresAt: new Date(Date.now() + 60_000),
  });
  const request = createDeviceRequest({ device: { machineId: 'fixture-machine', boardId: 'fixture-board', systemDiskId: 'fixture-disk' } });
  const keys = { ...generateIssuerKeyPair(), keyId: 'provision-test' };
  const license = await redeemActivationCode(redeemer, { code, request }, keys);
  assert.ok(verifyLicense({ license, publicKeyPem: keys.publicKeyPem, request, runningVersion: '0.8.5' }).valid);
  assert.deepEqual(await redeemActivationCode(redeemer, { code, request }, keys), license);
  await assert.rejects(redeemer.query('SELECT * FROM lee_t_customers'), { code: '42501' });
  await assert.rejects(redeemer.query('UPDATE lee_t_activation_codes SET version=version'), { code: '42501' });
  await assert.rejects(manager.query('UPDATE lee_t_activation_codes SET license=license'), { code: '42501' });
  await assert.rejects(manager.query('DELETE FROM lee_t_management_audit'), { code: '42501' });
  const { rows } = await owner.query('SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=$1 AND rowsecurity', [issuerSchema]);
  assert.equal(rows[0].n, 7);
  await owner.query(`CREATE ROLE ${outsiderRole} NOLOGIN NOBYPASSRLS`);
  outsiderCreated = true;
  await assert.rejects(outsider.query(`SELECT * FROM ${issuerSchema}.lee_t_activation_codes`), { code: '42501' });
  await owner.query(`GRANT USAGE ON SCHEMA ${issuerSchema} TO ${outsiderRole}`);
  await owner.query(`GRANT SELECT ON ${issuerSchema}.lee_t_activation_codes TO ${outsiderRole}`);
  assert.equal((await outsider.query(`SELECT * FROM ${issuerSchema}.lee_t_activation_codes`)).rowCount, 0);
  console.log('License Center provisioning: private schema, role separation, issuance, redemption and offline verification passed.');
} finally {
  await Promise.all([manager.end(), redeemer.end(), outsider.end()]);
  if (provisioned) {
    await owner.query(`DROP SCHEMA ${issuerSchema} CASCADE`);
    await owner.query(`DROP ROLE ${managementRole}, ${redemptionRole}`);
  }
  if (outsiderCreated) await owner.query(`DROP ROLE ${outsiderRole}`);
  await owner.end();
}
