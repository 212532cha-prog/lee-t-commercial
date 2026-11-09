import pg from 'pg';
import { issuerPoolOptions } from '../integrations/license-center/edge-config.mjs';
import { provisionIssuer } from '../integrations/license-center/provision.mjs';

let pool;
try {
  const options = issuerPoolOptions({
    LEE_T_ISSUER_DATABASE_URL: process.env.LEE_T_PROVISION_DATABASE_URL,
    LEE_T_ISSUER_DB_CA: process.env.LEE_T_ISSUER_DB_CA,
  });
  pool = new pg.Pool({ ...options, options: '-c search_path=pg_catalog', application_name: 'lee-t-provision' });
  await provisionIssuer(pool);
  console.log('Private issuer schema and separate runtime roles provisioned.');
} catch (error) {
  const safe = ['ISSUER_PROVISIONING_REQUIRES_FRESH_DATABASE', 'ISSUER_DATABASE_CONFIGURATION_REQUIRED'];
  console.error(safe.includes(error.message) ? error.message : 'License Center provisioning failed.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
