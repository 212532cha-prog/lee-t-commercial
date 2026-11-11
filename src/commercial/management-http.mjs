import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { verify } from '@node-rs/argon2';
import {
  confirmLicensePayment, issuePaidActivation, listLicenseAudit, listLicenseCustomers,
  listLicensePayments, registerLicenseCustomer, signPaidOfflineLicense,
} from './license-management.mjs';
import { validateActivationIssuer } from './activation-fetch.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const routes = new Map([
  ['GET /api/customers', (db, actor) => listLicenseCustomers(db, actor)],
  ['POST /api/customers', registerLicenseCustomer],
  ['GET /api/payments', (db, actor, { customerId }) => listLicensePayments(db, actor, customerId)],
  ['POST /api/payments', confirmLicensePayment],
  ['POST /api/issue', (db, actor, input) => issuePaidActivation(db, actor, { ...input, expiresAt: new Date(input.expiresAt) })],
  ['GET /api/audit', (db, actor, { customerId }) => listLicenseAudit(db, actor, customerId)],
]);
const assets = new Map([
  ['/', ['management.html', 'text/html; charset=utf-8']],
  ['/management.js', ['management.js', 'text/javascript; charset=utf-8']],
]);

function error(status, code) {
  return Object.assign(Error(code), { status });
}

function reply(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function jsonBody(req) {
  if (req.headers['content-type'] !== 'application/json') throw error(415, 'JSON_REQUIRED');
  let length = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 8192) throw error(413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
    return body;
  } catch {
    throw error(400, 'INVALID_JSON');
  }
}

export function createManagementServer({ tls, origin, operators, pool, offlineIssuer, offlineOnly = false, onError = () => {} }) {
  if (!(tls?.pfx || (tls?.key && tls.cert)) || !tls.ca || !pool || !Array.isArray(operators) || !operators.length ||
      new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) {
    throw Error('Management requires an HTTPS origin, client CA, database and operator configuration.');
  }
  const managementRoutes = new Map(routes);
  if (offlineOnly) {
    if (!offlineIssuer) throw Error('Offline-only management requires an offline issuer.');
    managementRoutes.delete('POST /api/issue');
  }
  if (offlineIssuer) {
    validateActivationIssuer(offlineIssuer);
    managementRoutes.set('POST /api/sign-offline', (db, actor, input) => signPaidOfflineLicense(db, actor, input, offlineIssuer));
  }
  const grants = new Map();
  for (const operator of operators) {
    const { id, role, fingerprint, passwordHash, customerId } = operator;
    if (!/^[a-z0-9._-]{1,64}$/i.test(id ?? '') || !['sales', 'issuer'].includes(role) ||
        !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(fingerprint ?? '') ||
        typeof passwordHash !== 'string' || !passwordHash.startsWith('$argon2id$') ||
        (customerId !== undefined && !uuid.test(customerId)) || grants.has(fingerprint)) {
      throw Error('Invalid management operator configuration.');
    }
    grants.set(fingerprint, { operator: { id, role, customerId }, passwordHash, attempts: [] });
  }
  return createServer({
    ...tls, requestCert: true, rejectUnauthorized: true,
    minVersion: 'TLSv1.2', requestTimeout: 10000,
  }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const grant = req.socket.authorized && grants.get(req.socket.getPeerCertificate().fingerprint256);
      if (!grant) throw error(403, 'OPERATOR_CERTIFICATE_REQUIRED');
      const basic = /^Basic ([A-Za-z0-9+/=]{1,512})$/.exec(req.headers.authorization ?? '');
      if (!basic) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Lee T License Center", charset="UTF-8"');
        throw error(401, 'OPERATOR_PASSWORD_REQUIRED');
      }
      const raw = Buffer.from(basic[1], 'base64').toString('utf8');
      const delimiter = raw.indexOf(':');
      const supplied = raw.slice(delimiter + 1);
      const attempt = { at: Date.now() };
      grant.attempts = grant.attempts.filter(entry => attempt.at - entry.at < 60000);
      if (grant.attempts.length >= 12) throw error(429, 'TOO_MANY_ATTEMPTS');
      grant.attempts.push(attempt);
      if (delimiter < 1 || raw.slice(0, delimiter) !== grant.operator.id || supplied.length > 128 ||
          !await verify(grant.passwordHash, supplied)) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Lee T License Center", charset="UTF-8"');
        throw error(401, 'OPERATOR_PASSWORD_REQUIRED');
      }
      // Keep failed attempts in the rolling window and remove only this successful attempt.
      grant.attempts = grant.attempts.filter(entry => entry !== attempt);
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw error(400, 'INVALID_URL');
      const url = new URL(req.url, origin);
      if (!offlineOnly && req.method === 'GET' && assets.has(url.pathname)) {
        const [name, mime] = assets.get(url.pathname);
        return reply(res, 200, await readFile(new URL('./management-ui/' + name, import.meta.url)), mime);
      }
      const handler = managementRoutes.get(req.method + ' ' + url.pathname);
      if (!handler) throw error(404, 'NOT_FOUND');
      if (req.method === 'POST' && req.headers.origin !== origin) throw error(403, 'ORIGIN_REJECTED');
      const input = req.method === 'POST' ? await jsonBody(req) : { customerId: url.searchParams.get('customerId') };
      if ((url.pathname !== '/api/customers' && !uuid.test(input.customerId ?? '')) ||
          (['/api/issue', '/api/sign-offline'].includes(url.pathname) && !uuid.test(input.paymentId ?? ''))) throw error(400, 'INVALID_ID');
      try {
        return reply(res, req.method === 'POST' ? 201 : 200, await handler(pool, grant.operator, input));
      } catch (cause) {
        if (cause.code === '23505') throw error(409, 'DUPLICATE_RECORD');
        if (cause.code === 'INVALID_ACTIVATION_CODE') throw error(409, 'LICENSE_REQUEST_CONFLICT');
        if (cause.code) throw cause;
        if (/access denied|role required/.test(cause.message)) throw error(403, 'OPERATOR_FORBIDDEN');
        if (/already has|already pending|already associated/.test(cause.message)) throw error(409, 'ISSUANCE_CONFLICT');
        throw error(422, 'REQUEST_REJECTED');
      }
    } catch (cause) {
      if (cause.status === 413) res.setHeader('Connection', 'close');
      if (!cause.status) onError();
      return reply(res, cause.status ?? 503, { error: cause.status ? cause.message : 'MANAGEMENT_UNAVAILABLE' });
    }
  });
}
