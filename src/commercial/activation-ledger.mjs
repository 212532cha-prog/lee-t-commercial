import { createHash, randomBytes } from 'node:crypto';
import { issueLicense, validateDeviceRequest } from './license.mjs';

const hash = code => createHash('sha256').update(code).digest('hex');
const invalidCode = () => Object.assign(Error('Invalid, expired or already redeemed activation code.'), { code: 'INVALID_ACTIVATION_CODE' });

export async function initializeActivationLedger(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lee_t_activation_codes (
      code_hash text PRIMARY KEY,
      customer_id text NOT NULL,
      version text NOT NULL,
      expires_at timestamptz NOT NULL,
      license jsonb,
      redeemed_at timestamptz,
      CHECK ((license IS NULL) = (redeemed_at IS NULL))
    );

    CREATE TABLE IF NOT EXISTS lee_t_activation_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code_hash text NOT NULL REFERENCES lee_t_activation_codes(code_hash),
      event text NOT NULL CHECK (event IN ('issued', 'redeemed')),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (code_hash, event)
    );
  `);
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// This function is for a trusted issuer only. A public activation endpoint must
// expose redemption alone. Use a database separate from any customer warehouse.
export async function createInitialActivationCode(pool, { customerId, version, paid, expiresAt }) {
  if (paid !== true) throw Error('Payment confirmation is required.');
  if (typeof customerId !== 'string' || !customerId.trim() || customerId.length > 160 ||
      typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
      !(expiresAt instanceof Date) || !(expiresAt.getTime() > Date.now())) {
    throw Error('Valid customer, version and expiry are required.');
  }
  const code = `LT-${randomBytes(24).toString('base64url')}`;
  const codeHash = hash(code);
  await transaction(pool, async client => {
    await client.query(
      'INSERT INTO lee_t_activation_codes (code_hash, customer_id, version, expires_at) VALUES ($1, $2, $3, $4)',
      [codeHash, customerId.trim(), version, expiresAt],
    );
    await client.query("INSERT INTO lee_t_activation_audit (code_hash, event) VALUES ($1, 'issued')", [codeHash]);
  });
  return code;
}

export async function redeemInitialActivationCode(pool, { code, request }, { privateKeyPem, keyId }) {
  if (typeof code !== 'string' || !/^LT-[A-Za-z0-9_-]{32}$/.test(code)) throw invalidCode();
  try {
    validateDeviceRequest(request);
  } catch {
    throw invalidCode();
  }
  const codeHash = hash(code);
  return transaction(pool, async client => {
    const { rows: [record] } = await client.query(
      'SELECT customer_id, version, license, expires_at FROM lee_t_activation_codes WHERE code_hash = $1 FOR UPDATE',
      [codeHash],
    );
    if (!record || record.expires_at.getTime() <= Date.now()) throw invalidCode();
    if (record.license) {
      const { installationId, deviceClaims } = record.license.payload;
      const sameRequest = installationId === request.installationId &&
        Object.entries(deviceClaims).every(([field, digest]) => request.claims[field] === digest);
      if (!sameRequest) throw invalidCode();
      return record.license;
    }
    const license = issueLicense({
      privateKeyPem, keyId, request, customerId: record.customer_id, version: record.version,
    });
    await client.query('UPDATE lee_t_activation_codes SET license = $2, redeemed_at = now() WHERE code_hash = $1', [codeHash, license]);
    await client.query("INSERT INTO lee_t_activation_audit (code_hash, event) VALUES ($1, 'redeemed')", [codeHash]);
    return license;
  });
}
