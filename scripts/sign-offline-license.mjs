import { open, readFile } from 'node:fs/promises';
import pg from 'pg';
import { redeemActivationCode } from '../src/commercial/activation-ledger.mjs';
import { canonical } from '../src/commercial/license.mjs';

let pool;
try {
  const [requestPath, ...extra] = process.argv.slice(2);
  if (!requestPath || extra.length) {
    throw Error('Usage: node scripts/sign-offline-license.mjs <device-request.json> < activation-code.txt');
  }
  const config = JSON.parse(await readFile(process.env.LEE_T_ACTIVATION_SERVICE_CONFIG, 'utf8'));
  if (!config.databaseUrl || !config.issuerKeyId || !config.issuerKeyPath) throw Error('Missing issuer configuration.');
  const requestFile = await open(requestPath, 'r');
  let request;
  try {
    const bytes = Buffer.alloc(4097);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await requestFile.read(bytes, offset, bytes.length - offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset === bytes.length) throw Error('Device request is too large.');
    request = JSON.parse(bytes.toString('utf8', 0, offset));
  } finally {
    await requestFile.close();
  }
  let code = '';
  for await (const chunk of process.stdin) {
    code += chunk;
    if (code.length > 100) throw Error('Invalid activation code.');
  }
  const privateKeyPem = await readFile(config.issuerKeyPath, 'utf8');
  pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000 });
  const license = await redeemActivationCode(pool, { code: code.trim(), request }, { privateKeyPem, keyId: config.issuerKeyId });
  console.log(canonical(license));
} catch (error) {
  if (error.code === 'INVALID_ACTIVATION_CODE') console.error('Invalid, expired or already redeemed activation code or device request.');
  else if (error instanceof SyntaxError) console.error('Invalid device request or issuer configuration JSON.');
  else console.error('Offline signing failed. Check the request file, issuer configuration and database.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
