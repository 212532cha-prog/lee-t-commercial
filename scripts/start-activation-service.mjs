import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { initializeActivationLedger } from '../src/commercial/activation-ledger.mjs';
import { createActivationServer } from '../src/commercial/activation-http.mjs';

import { initializeLicenseManagement } from '../src/commercial/license-management.mjs';

let pool;
try {
  const settings = JSON.parse(await readFile(process.env.LEE_T_ACTIVATION_SERVICE_CONFIG, 'utf8'));
  if (!settings.databaseUrl || !settings.issuerKeyId) throw Error('Missing activation service configuration.');
  const port = Number(settings.port ?? 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid activation service port.');
  const [key, cert, privateKeyPem] = await Promise.all([
    readFile(settings.tlsKeyPath), readFile(settings.tlsCertPath), readFile(settings.issuerKeyPath, 'utf8'),
  ]);
  pool = new pg.Pool({ connectionString: settings.databaseUrl, connectionTimeoutMillis: 5000 });
  await initializeActivationLedger(pool);
  await initializeLicenseManagement(pool);
  const server = createActivationServer({
    pool, tls: { key, cert }, issuer: { privateKeyPem, keyId: settings.issuerKeyId },
    onError: () => console.error('Activation redemption failed.'),
  });
  server.on('error', async () => {
    console.error('Activation service listener failed.');
    process.exitCode = 1;
    await pool.end();
  });
  const stop = () => server.close(() => pool.end());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.listen(port, settings.bind ?? '127.0.0.1', () => console.log('Lee T activation service ready.'));
} catch {
  console.error('Activation service startup failed. Check protected issuer, TLS and database configuration.');
  process.exitCode = 1;
  if (pool) await pool.end();
}
