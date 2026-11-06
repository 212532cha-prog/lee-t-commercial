import { createHash, randomBytes } from 'node:crypto';
import { transaction } from '../db/database.mjs';
import { compareVersions, issueLicense, validateDeviceRequest } from './license.mjs';

export const activationCodeHash = code => createHash('sha256').update(code).digest('hex');
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

    CREATE UNIQUE INDEX IF NOT EXISTS lee_t_activation_license_id
      ON lee_t_activation_codes ((license->'payload'->>'licenseId'));

    CREATE TABLE IF NOT EXISTS lee_t_activation_followups (
      code_hash text PRIMARY KEY REFERENCES lee_t_activation_codes(code_hash),
      prior_code_hash text NOT NULL REFERENCES lee_t_activation_codes(code_hash),
      kind text NOT NULL CHECK (kind IN ('upgrade', 'transfer')),
      target_request jsonb NOT NULL,
      payment_reference text NOT NULL,
      approved_by text NOT NULL,
      replaced_at timestamptz
    );

    CREATE UNIQUE INDEX IF NOT EXISTS lee_t_followup_payment_reference
      ON lee_t_activation_followups (payment_reference) WHERE replaced_at IS NULL;

    CREATE TABLE IF NOT EXISTS lee_t_activation_successions (
      prior_code_hash text PRIMARY KEY REFERENCES lee_t_activation_codes(code_hash),
      successor_code_hash text NOT NULL UNIQUE REFERENCES lee_t_activation_followups(code_hash)
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

// This function is for a trusted issuer only. A public activation endpoint must
// expose redemption alone. Use a database separate from any customer warehouse.
export function createInitialActivationCode(pool, input) {
  return transaction(pool, client => createInitialActivationCodeIn(client, input));
}

export async function createInitialActivationCodeIn(client, { customerId, version, paid, expiresAt }) {
  if (paid !== true) throw Error('Payment confirmation is required.');
  if (typeof customerId !== 'string' || !customerId.trim() || customerId.length > 160 ||
      typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
      !(expiresAt instanceof Date) || !(expiresAt.getTime() > Date.now())) {
    throw Error('Valid customer, version and expiry are required.');
  }
  return insertCode(client, { customerId: customerId.trim(), version, expiresAt });
}

async function insertCode(client, { customerId, version, expiresAt }) {
  const code = `LT-${randomBytes(24).toString('base64url')}`;
  const codeHash = activationCodeHash(code);
  await client.query(
    'INSERT INTO lee_t_activation_codes (code_hash, customer_id, version, expires_at) VALUES ($1, $2, $3, $4)',
    [codeHash, customerId, version, expiresAt],
  );
  await client.query("INSERT INTO lee_t_activation_audit (code_hash, event) VALUES ($1, 'issued')", [codeHash]);
  return code;
}

function matchingClaims(claims, request) {
  return Object.entries(claims).filter(([field, digest]) => request.claims[field] === digest).length;
}

function validText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

// Only the authenticated issuer may approve purchases and submit device requests.
export function createFollowupActivationCode(pool, input) {
  return transaction(pool, client => createFollowupActivationCodeIn(client, input));
}

export async function createFollowupActivationCodeIn(client, {
  customerId, priorLicenseId, kind, version, expiresAt, request, paid, paymentReference, approvedBy,
}) {
  if (paid !== true || !validText(paymentReference) || !validText(approvedBy)) {
    throw Error('Payment confirmation, reference and operator approval are required.');
  }
  if (!validText(customerId) || !validText(priorLicenseId) || !['upgrade', 'transfer'].includes(kind) ||
      typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
      !(expiresAt instanceof Date) || !(expiresAt.getTime() > Date.now())) {
    throw Error('Valid customer, prior license, kind, version and expiry are required.');
  }
  validateDeviceRequest(request);
  const { rows: [prior] } = await client.query(
    `SELECT code_hash, license FROM lee_t_activation_codes
     WHERE license->'payload'->>'licenseId' = $1 AND customer_id = $2 FOR UPDATE`,
    [priorLicenseId, customerId.trim()],
  );
  if (!prior || await hasSuccessor(client, prior.code_hash)) throw Error('An active prior license for this customer is required.');
  const pending = await client.query(
    `SELECT 1 FROM lee_t_activation_followups AS f
     JOIN lee_t_activation_codes AS c ON c.code_hash = f.code_hash
     WHERE f.prior_code_hash = $1 AND c.expires_at > clock_timestamp()`, [prior.code_hash],
  );
  if (pending.rows.length) throw Error('A follow-up approval is already pending for this license.');
  const payload = prior.license.payload;
  const versionChange = compareVersions(version, payload.entitledVersion);
  if (versionChange < 0 || (kind === 'upgrade' && versionChange === 0)) throw Error('Invalid target version for this purchase.');
  const sameInstallation = payload.installationId === request.installationId;
  const matches = matchingClaims(payload.deviceClaims, request);
  if (kind === 'upgrade' && (!sameInstallation || matches < 2)) throw Error('Upgrade requires the current installation.');
  if (kind === 'transfer' && (sameInstallation || matches >= 2)) throw Error('Transfer requires a different server.');
  const targetRequest = { installationId: request.installationId, claims: request.claims };
  const payment = paymentReference.trim();
  const { rows: [previousApproval] } = await client.query(
    `SELECT f.code_hash, f.prior_code_hash, f.kind, f.target_request, c.version,
            c.redeemed_at, c.expires_at > clock_timestamp() AS live
     FROM lee_t_activation_followups AS f
     JOIN lee_t_activation_codes AS c ON c.code_hash = f.code_hash
     WHERE f.payment_reference = $1 AND f.replaced_at IS NULL`, [payment],
  );
  if (previousApproval) {
    if (previousApproval.prior_code_hash !== prior.code_hash || previousApproval.kind !== kind ||
        previousApproval.version !== version || previousApproval.redeemed_at || previousApproval.live ||
        previousApproval.target_request.installationId !== request.installationId ||
        matchingClaims(previousApproval.target_request.claims, request) !== 3) {
      throw Error('Payment reference is already associated with another approval.');
    }
    await client.query('UPDATE lee_t_activation_followups SET replaced_at = now() WHERE code_hash = $1', [previousApproval.code_hash]);
  }
  const code = await insertCode(client, { customerId: customerId.trim(), version, expiresAt });
  await client.query(
    `INSERT INTO lee_t_activation_followups
     (code_hash, prior_code_hash, kind, target_request, payment_reference, approved_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [activationCodeHash(code), prior.code_hash, kind, targetRequest, payment, approvedBy.trim()],
  );
  return code;
}

async function hasSuccessor(client, codeHash) {
  const { rows } = await client.query(
    'SELECT 1 FROM lee_t_activation_successions WHERE prior_code_hash = $1', [codeHash],
  );
  return rows.length > 0;
}

export function redeemInitialActivationCode(pool, input, issuer) {
  return redeemActivationCode(pool, input, issuer, { initialOnly: true });
}

export async function redeemActivationCode(pool, { code, request }, { privateKeyPem, keyId }, { initialOnly = false } = {}) {
  if (typeof code !== 'string' || !/^LT-[A-Za-z0-9_-]{32}$/.test(code)) throw invalidCode();
  try {
    validateDeviceRequest(request);
  } catch {
    throw invalidCode();
  }
  const codeHash = activationCodeHash(code);
  return transaction(pool, async client => {
    const { rows: [record] } = await client.query(
      'SELECT customer_id, version, license, expires_at > clock_timestamp() AS live FROM lee_t_activation_codes WHERE code_hash = $1 FOR UPDATE',
      [codeHash],
    );
    if (!record?.live) throw invalidCode();
    const { rows: [followup] } = await client.query(
      'SELECT prior_code_hash, kind, target_request, replaced_at FROM lee_t_activation_followups WHERE code_hash = $1', [codeHash],
    );
    if ((initialOnly && followup) || followup?.replaced_at || await hasSuccessor(client, codeHash)) throw invalidCode();
    if (record.license) {
      const { installationId, deviceClaims } = record.license.payload;
      const sameRequest = installationId === request.installationId &&
        matchingClaims(deviceClaims, request) === 3;
      if (!sameRequest) throw invalidCode();
      return record.license;
    }
    let priorLicenseId = null;
    if (followup) {
      const { installationId, claims } = followup.target_request;
      if (installationId !== request.installationId || matchingClaims(claims, request) !== 3) throw invalidCode();
      const { rows: [prior] } = await client.query(
        'SELECT license FROM lee_t_activation_codes WHERE code_hash = $1 FOR UPDATE', [followup.prior_code_hash],
      );
      if (!prior?.license || await hasSuccessor(client, followup.prior_code_hash)) throw invalidCode();
      const { rows: [approval] } = await client.query(
        `SELECT c.expires_at > clock_timestamp() AS live, f.replaced_at
         FROM lee_t_activation_followups AS f
         JOIN lee_t_activation_codes AS c ON c.code_hash = f.code_hash
         WHERE f.code_hash = $1`, [codeHash],
      );
      if (!approval?.live || approval.replaced_at) throw invalidCode();
      priorLicenseId = prior.license.payload.licenseId;
      await client.query(
        'INSERT INTO lee_t_activation_successions (prior_code_hash, successor_code_hash) VALUES ($1, $2)',
        [followup.prior_code_hash, codeHash],
      );
    }
    const license = issueLicense({
      privateKeyPem, keyId, request, customerId: record.customer_id, version: record.version, kind: followup?.kind, priorLicenseId,
    });
    await client.query('UPDATE lee_t_activation_codes SET license = $2, redeemed_at = now() WHERE code_hash = $1', [codeHash, license]);
    await client.query("INSERT INTO lee_t_activation_audit (code_hash, event) VALUES ($1, 'redeemed')", [codeHash]);
    return license;
  });
}
