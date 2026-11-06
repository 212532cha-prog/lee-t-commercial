import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createFollowupActivationCode, createInitialActivationCode } from '../src/commercial/activation-ledger.mjs';

let pool;
try {
  const settings = JSON.parse(await readFile(process.env.LEE_T_ACTIVATION_SERVICE_CONFIG, 'utf8'));
  if (!settings.databaseUrl) throw Error('Missing activation database configuration.');
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || extra.length) throw Error('Usage: node scripts/issue-activation-code.mjs <approval.json>');
  const approval = JSON.parse(await readFile(filename, 'utf8'));
  if (!['initial', 'upgrade', 'transfer'].includes(approval.kind)) throw Error('Invalid approval kind.');
  pool = new pg.Pool({ connectionString: settings.databaseUrl, connectionTimeoutMillis: 5000 });
  const issue = approval.kind === 'initial' ? createInitialActivationCode : createFollowupActivationCode;
  console.log(await issue(pool, { ...approval, expiresAt: new Date(approval.expiresAt) }));
} catch (error) {
  // Driver errors may contain database details. Only expose the error code.
  console.error(error.code ? `Activation code issuance failed (${error.code}).` : error.message);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
