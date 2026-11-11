import { randomUUID } from 'node:crypto';
import { transaction } from '../db/database.mjs';
import { activationCodeHash, createFollowupActivationCodeIn, createInitialActivationCodeIn, redeemActivationCodeIn } from './activation-ledger.mjs';
import { validateDeviceRequest } from './license.mjs';

export async function initializeLicenseManagement(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lee_t_customers (
      id uuid PRIMARY KEY,
      company_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS lee_t_management_payments (
      id uuid PRIMARY KEY,
      customer_id uuid NOT NULL REFERENCES lee_t_customers(id),
      receipt_reference text NOT NULL UNIQUE,
      kind text NOT NULL CHECK (kind IN ('initial', 'upgrade', 'transfer')),
      version text NOT NULL,
      confirmed_by text NOT NULL,
      confirmed_at timestamptz NOT NULL DEFAULT now(),
      code_hash text UNIQUE REFERENCES lee_t_activation_codes(code_hash)
    );
    CREATE TABLE IF NOT EXISTS lee_t_management_audit (
      id uuid PRIMARY KEY,
      customer_id uuid NOT NULL REFERENCES lee_t_customers(id),
      payment_id uuid REFERENCES lee_t_management_payments(id),
      actor text NOT NULL,
      action text NOT NULL CHECK (action IN ('customer_created', 'payment_confirmed', 'code_issued', 'code_reissued')),
      happened_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160 || /[\x00-\x1f\x7f]/.test(value)) {
    throw Error(`Invalid ${name}.`);
  }
  return value.trim();
}

function customerScope(operator, customerId) {
  if (!operator || !['sales', 'issuer'].includes(operator.role)) throw Error('Operator access required.');
  if (operator.customerId && operator.customerId !== customerId) throw Error('Customer access denied.');
  return text(operator.id, 'operator');
}

async function audit(db, { customerId, paymentId = null, actor, action }) {
  await db.query(
    'INSERT INTO lee_t_management_audit(id,customer_id,payment_id,actor,action) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), customerId, paymentId, actor, action],
  );
}

export async function registerLicenseCustomer(pool, operator, { companyName }) {
  const actor = customerScope(operator);
  const id = randomUUID();
  const name = text(companyName, 'company name');
  return transaction(pool, async db => {
    await db.query('INSERT INTO lee_t_customers(id,company_name) VALUES($1,$2)', [id, name]);
    await audit(db, { customerId: id, actor, action: 'customer_created' });
    return { id, companyName: name };
  });
}

export async function confirmLicensePayment(pool, operator, { customerId, receiptReference, kind, version }) {
  const actor = customerScope(operator, customerId);
  if (!['initial', 'upgrade', 'transfer'].includes(kind) || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || version.length > 40) {
    throw Error('Valid purchase kind and version required.');
  }
  const receipt = text(receiptReference, 'receipt reference');
  const id = randomUUID();
  return transaction(pool, async db => {
    const customer = await db.query('SELECT id FROM lee_t_customers WHERE id=$1', [customerId]);
    if (!customer.rows.length) throw Error('Customer does not exist.');
    await db.query(
      `INSERT INTO lee_t_management_payments(id,customer_id,receipt_reference,kind,version,confirmed_by)
       VALUES($1,$2,$3,$4,$5,$6)`, [id, customerId, receipt, kind, version, actor],
    );
    await audit(db, { customerId, paymentId: id, actor, action: 'payment_confirmed' });
    return { id, customerId, receiptReference: receipt, kind, version };
  });
}

async function lockPayment(db, customerId, paymentId) {
  const { rows: [payment] } = await db.query(
    'SELECT * FROM lee_t_management_payments WHERE id=$1 AND customer_id=$2 FOR UPDATE', [paymentId, customerId],
  );
  if (!payment) throw Error('Confirmed payment for this customer required.');
  return payment;
}

async function issueForPayment(db, actor, payment, { customerId, paymentId, expiresAt, priorLicenseId, request }) {
  if (payment.code_hash) {
    const { rows: [prior] } = await db.query(
      'SELECT redeemed_at,expires_at > clock_timestamp() AS live FROM lee_t_activation_codes WHERE code_hash=$1 FOR UPDATE',
      [payment.code_hash],
    );
    if (prior.redeemed_at || prior.live) throw Error('Payment already has an activation code.');
  }
  const input = {
    customerId, paid: true, version: payment.version, kind: payment.kind, expiresAt,
    priorLicenseId, request, paymentReference: payment.receipt_reference, approvedBy: actor,
  };
  const issue = payment.kind === 'initial' ? createInitialActivationCodeIn : createFollowupActivationCodeIn;
  const code = await issue(db, input);
  await db.query('UPDATE lee_t_management_payments SET code_hash=$2 WHERE id=$1', [paymentId, activationCodeHash(code)]);
  await audit(db, { customerId, paymentId, actor, action: payment.code_hash ? 'code_reissued' : 'code_issued' });
  return { code, expiresAt };
}

export async function issuePaidActivation(pool, operator, input) {
  const actor = customerScope(operator, input.customerId);
  if (operator.role !== 'issuer') throw Error('Issuer role required.');
  return transaction(pool, async db => issueForPayment(db, actor,
    await lockPayment(db, input.customerId, input.paymentId), input));
}

export async function signPaidOfflineLicense(pool, operator, input, issuer) {
  const { customerId, paymentId, request } = input;
  const actor = customerScope(operator, customerId);
  if (operator.role !== 'issuer') throw Error('Issuer role required.');
  validateDeviceRequest(request);
  return transaction(pool, async db => {
    const payment = await lockPayment(db, customerId, paymentId);
    if (payment.code_hash) {
      const { rows: [record] } = await db.query(
        'SELECT redeemed_at FROM lee_t_activation_codes WHERE code_hash=$1', [payment.code_hash],
      );
      if (record.redeemed_at) {
        return redeemActivationCodeIn(db, payment.code_hash, request, issuer, { allowExpiredSigned: true });
      }
    }
    const { code } = await issueForPayment(db, actor, payment, {
      ...input, expiresAt: new Date(Date.now() + 600_000),
    });
    return redeemActivationCodeIn(db, activationCodeHash(code), request, issuer);
  });
}

export async function listLicensePayments(pool, operator, customerId) {
  customerScope(operator, customerId);
  return (await pool.query(
    `SELECT p.id,p.receipt_reference,p.kind,p.version,p.confirmed_by,p.confirmed_at,
       CASE WHEN c.redeemed_at IS NOT NULL THEN 'redeemed' WHEN c.expires_at>clock_timestamp() THEN 'issued'
            WHEN c.code_hash IS NOT NULL THEN 'expired' ELSE 'confirmed' END AS status
     FROM lee_t_management_payments p LEFT JOIN lee_t_activation_codes c ON c.code_hash=p.code_hash
     WHERE p.customer_id=$1 ORDER BY p.confirmed_at,p.id`, [customerId],
  )).rows;
}

export async function listLicenseCustomers(pool, operator) {
  customerScope(operator, operator?.customerId);
  return (await pool.query(
    'SELECT id,company_name,created_at FROM lee_t_customers WHERE ($1::uuid IS NULL OR id=$1) ORDER BY company_name,id',
    [operator.customerId ?? null],
  )).rows;
}

export async function listLicenseAudit(pool, operator, customerId) {
  customerScope(operator, customerId);
  return (await pool.query(
    `SELECT id,payment_id,actor,action,happened_at FROM lee_t_management_audit
     WHERE customer_id=$1 ORDER BY happened_at DESC,id LIMIT 100`, [customerId],
  )).rows;
}
