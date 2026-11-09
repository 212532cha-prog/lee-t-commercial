import { X509Certificate, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { hashPassword } from '../src/auth/service.mjs';
import { initializeActivationLedger } from '../src/commercial/activation-ledger.mjs';
import { generateIssuerKeyPair } from '../src/commercial/license.mjs';
import { initializeLicenseManagement } from '../src/commercial/license-management.mjs';
import { transaction } from '../src/db/database.mjs';

let pool;
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8192) throw Error('Setup input too large.');
  }
  const { root, databaseUrl, port, pfxPassphrase, operatorPassword } = JSON.parse(input);
  const db = new URL(databaseUrl);
  if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' ||
      db.username !== 'leet_license_app' || db.pathname !== '/leet_issuer' || db.search ||
      !Number.isInteger(port) || port < 1024 || port > 65535 ||
      typeof operatorPassword !== 'string' || operatorPassword.length < 12 || operatorPassword.length > 128) {
    throw Error('Invalid local setup.');
  }
  const fingerprint = new X509Certificate(await readFile(join(root, 'operator.cer'))).fingerprint256;
  const issuerKeyId = 'leet-local-' + randomUUID();
  const issuerKeyPath = join(root, 'issuer.key');
  const { privateKeyPem, publicKeyPem } = generateIssuerKeyPair();
  pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await transaction(pool, async client => {
    const { rows: [current] } = await client.query('SELECT current_database() AS name');
    if (current.name !== 'leet_issuer') throw Error('Dedicated issuer database required.');
    await initializeActivationLedger(client);
    await initializeLicenseManagement(client);
  });
  const writeNew = (name, content) => writeFile(join(root, name), content, { flag: 'wx', mode: 0o600 });
  await writeNew('issuer.key', privateKeyPem);
  await writeNew('issuer-public.pem', publicKeyPem);
  await writeNew('issuer-key-id.txt', issuerKeyId + '\n');
  await writeNew('management.private.json', JSON.stringify({
    databaseUrl, origin: 'https://127.0.0.1:' + port, bind: '127.0.0.1',
    tlsPfxPath: join(root, 'management.pfx'), tlsPfxPassphrase: pfxPassphrase,
    clientCaPath: join(root, 'management-ca.cer'), issuerKeyId, issuerKeyPath,
    operators: [{ id: 'issuer', role: 'issuer', fingerprint, passwordHash: await hashPassword(operatorPassword) }],
  }, null, 2));
  console.log('Local issuer ledger and configuration initialized.');
} catch {
  console.error('Local License Center initialization failed.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
