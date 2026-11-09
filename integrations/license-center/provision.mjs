import { initializeActivationLedger } from '../../src/commercial/activation-ledger.mjs';
import { initializeLicenseManagement } from '../../src/commercial/license-management.mjs';
import { transaction } from '../../src/db/database.mjs';

export const issuerSchema = 'lee_t_license';
export const redemptionRole = 'lee_t_redeemer';
export const managementRole = 'lee_t_manager';

const access = {
  lee_t_activation_codes: ['SELECT, UPDATE (license, redeemed_at)', 'SELECT, INSERT, UPDATE (code_hash)'],
  lee_t_activation_followups: ['SELECT', 'SELECT, INSERT, UPDATE (replaced_at)'],
  lee_t_activation_successions: ['SELECT, INSERT', 'SELECT'],
  lee_t_activation_audit: ["INSERT", "INSERT"],
  lee_t_customers: [null, 'SELECT, INSERT'],
  lee_t_management_payments: [null, 'SELECT, INSERT, UPDATE (code_hash)'],
  lee_t_management_audit: [null, 'SELECT, INSERT'],
};

// Provision a fresh issuer database as its administrator, before deploying a
// runtime. Existing schemas or roles require a separate migration.
export function provisionIssuer(pool) {
  return transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(2026110901)');
    const occupied = await db.query(
      'SELECT 1 FROM pg_namespace WHERE nspname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])',
      [issuerSchema, [redemptionRole, managementRole]],
    );
    if (occupied.rowCount) throw Error('ISSUER_PROVISIONING_REQUIRES_FRESH_DATABASE');

    await db.query(`CREATE SCHEMA ${issuerSchema}`);
    for (const role of [redemptionRole, managementRole]) {
      await db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await db.query(`GRANT USAGE ON SCHEMA ${issuerSchema} TO ${role}`);
    }
    await db.query(`SET LOCAL search_path = ${issuerSchema}, pg_catalog`);
    await initializeActivationLedger(db);
    await initializeLicenseManagement(db);

    const platformRoles = await db.query(
      'SELECT rolname FROM pg_roles WHERE rolname IN (\'anon\', \'authenticated\', \'service_role\')',
    );
    const excluded = ['PUBLIC', ...platformRoles.rows.map(row => row.rolname)].join(', ');
    await db.query(`REVOKE ALL ON SCHEMA ${issuerSchema} FROM ${excluded}`);
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${issuerSchema} FROM ${excluded}`);
    await db.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${issuerSchema} FROM ${excluded}`);
    for (const [table, grants] of Object.entries(access)) {
      const relation = `${issuerSchema}.${table}`;
      await db.query(`ALTER TABLE ${relation} ENABLE ROW LEVEL SECURITY`);
      for (const [index, role] of [redemptionRole, managementRole].entries()) {
        const grant = grants[index];
        if (!grant) continue;
        await db.query(`GRANT ${grant} ON ${relation} TO ${role}`);
        await db.query(`CREATE POLICY ${role}_access ON ${relation} TO ${role} USING (true) WITH CHECK (true)`);
      }
    }
    await db.query(`GRANT USAGE ON SEQUENCE ${issuerSchema}.lee_t_activation_audit_id_seq TO ${redemptionRole}, ${managementRole}`);
  });
}
