import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createManagementServer } from '../src/commercial/management-http.mjs';

let pool;
try {
  const settings = JSON.parse(await readFile(process.env.LEE_T_MANAGEMENT_CONFIG, 'utf8'));
  if (!settings.databaseUrl) throw Error('Missing management database configuration.');
  const origin = new URL(settings.origin);
  const port = Number(origin.port || 443);
  const [key, cert, ca] = await Promise.all([
    readFile(settings.tlsKeyPath), readFile(settings.tlsCertPath), readFile(settings.clientCaPath),
  ]);
  pool = new pg.Pool({ connectionString: settings.databaseUrl, connectionTimeoutMillis: 5000 });
  await pool.query('SELECT id FROM lee_t_customers LIMIT 0');
  const server = createManagementServer({
    tls: { key, cert, ca }, origin: settings.origin, operators: settings.operators, pool,
    onError: () => console.error('License management request failed.'),
  });
  server.on('error', async () => {
    console.error('License management listener failed.');
    process.exitCode = 1;
    await pool.end();
  });
  const stop = () => server.close(() => pool.end());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.listen(port, settings.bind ?? '127.0.0.1', () => console.log('Lee T License Center management ready.'));
} catch {
  console.error('License management startup failed. Check the protected configuration, TLS and issuer database.');
  process.exitCode = 1;
  if (pool) await pool.end();
}
