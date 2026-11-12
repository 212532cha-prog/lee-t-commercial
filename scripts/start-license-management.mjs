import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import pg from 'pg';
import { createManagementServer } from '../src/commercial/management-http.mjs';

let pool;
let stage = 'configuration';
try {
  const settings = JSON.parse(await readFile(process.env.LEE_T_MANAGEMENT_CONFIG, 'utf8'));
  if (!settings.databaseUrl) throw Error('Missing management database configuration.');
  const origin = new URL(settings.origin);
  const port = Number(origin.port || 443);
  const bind = settings.bind ?? '127.0.0.1';
  stage = 'TLS certificate';
  const caBytes = await readFile(settings.clientCaPath);
  const tls = settings.tlsPfxPath
    ? { pfx: await readFile(settings.tlsPfxPath), passphrase: settings.tlsPfxPassphrase, ca: new X509Certificate(caBytes).toString() }
    : { key: await readFile(settings.tlsKeyPath), cert: await readFile(settings.tlsCertPath), ca: caBytes };
  stage = 'signing key';
  let offlineIssuer;
  if (settings.issuerKeyId || settings.issuerKeyPath) {
    if (!settings.issuerKeyId || !settings.issuerKeyPath) throw Error('Incomplete offline issuer configuration.');
    if (!['127.0.0.1', '::1'].includes(bind) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
      throw Error('Offline signing requires a loopback listener and origin.');
    }
    offlineIssuer = { keyId: settings.issuerKeyId, privateKeyPem: await readFile(settings.issuerKeyPath, 'utf8') };
  }
  stage = 'issuer database';
  pool = new pg.Pool({ connectionString: settings.databaseUrl, connectionTimeoutMillis: 5000 });
  await pool.query('SELECT id FROM lee_t_customers LIMIT 0');
  stage = 'backend initialization';
  const server = createManagementServer({
    tls, origin: settings.origin, operators: settings.operators, pool, offlineIssuer, offlineOnly: process.env.LEE_T_OFFLINE_ONLY === '1',
    onError: () => console.error('License management request failed.'),
  });
  server.on('error', async () => {
    console.error('License management listener failed.');
    process.exitCode = 1;
    await pool.end();
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.stdin.pause();
    server.close(() => pool.end());
    server.closeIdleConnections();
  };
  // The Windows service host sends this through a private inherited pipe.
  process.stdin.setEncoding('utf8');
  let control = '';
  process.stdin.on('data', chunk => {
    control = (control + chunk).slice(-64);
    if (control.includes('shutdown\n') || control.includes('shutdown\r\n')) stop();
  });
  process.stdin.unref?.();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.listen(port, bind, () => console.log('Lee T License Center management ready.'));
} catch {
  console.error('License management startup failed at: ' + stage + '. Check the protected configuration and issuer service log.');
  process.exitCode = 1;
  if (pool) await pool.end();
}
