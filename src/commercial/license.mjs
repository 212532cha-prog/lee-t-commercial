/** Lee T commercial offline licensing primitives.
 * The signing PRIVATE key must live exclusively in the issuer's protected environment.
 * These primitives do not redeem one-time activation codes: that requires a separate
 * transactional License Center service, which must never ship with the customer installer.
 */
import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';

const PRODUCT = 'lee-t-warehouse';
const DEVICE_FIELDS = ['machineId', 'boardId', 'systemDiskId'];
const ALLOWED_KIND = new Set(['initial', 'upgrade', 'transfer']);
const MAX_TEXT = 160;

function fail(message) { throw new Error(`Lee T license: ${message}`); }
function isRecord(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) fail(`invalid ${field}`);
  return value.trim();
}
function assertUtc(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) fail(`invalid ${field}`);
  return value;
}
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  fail('unsupported data type');
}
const digest = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

export function generateIssuerKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

/** Hash multiple stable device claims; never transfer raw serial numbers to the license. */
export function createDeviceRequest({ device, installationId = randomUUID() }) {
  if (!isRecord(device)) fail('missing device identifiers');
  const claims = {};
  for (const field of DEVICE_FIELDS) {
    claims[field] = digest(`${PRODUCT}:device:${field}:${nonempty(device[field], field)}`);
  }
  nonempty(installationId, 'installationId');
  return { schema: 1, product: PRODUCT, installationId, claims };
}

export function validateDeviceRequest(request) {
  if (!isRecord(request) || request.schema !== 1 || request.product !== PRODUCT) fail('invalid activation request');
  nonempty(request.installationId, 'installationId');
  if (!isRecord(request.claims) || Object.keys(request.claims).sort().join(',') !== DEVICE_FIELDS.slice().sort().join(',')) fail('invalid device claims');
  for (const field of DEVICE_FIELDS) if (typeof request.claims[field] !== 'string' || !/^[a-f0-9]{64}$/.test(request.claims[field])) fail(`invalid ${field} claim`);
}

/** Sign a license once the License Center has checked payment and redeemed the key. */
export function issueLicense({ privateKeyPem, keyId, request, customerId, licenseId = randomUUID(), kind = 'initial', version, issuedAt = new Date().toISOString(), priorLicenseId = null }) {
  validateDeviceRequest(request);
  nonempty(keyId, 'keyId');
  nonempty(customerId, 'customerId');
  nonempty(licenseId, 'licenseId');
  if (!ALLOWED_KIND.has(kind)) fail('invalid license kind');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) fail('invalid version');
  assertUtc(issuedAt, 'issuedAt');
  if (priorLicenseId !== null) nonempty(priorLicenseId, 'priorLicenseId');
  if (kind !== 'initial' && priorLicenseId === null) fail('upgrade and transfer need a previous license');
  const payload = {
    schema: 1, product: PRODUCT, licenseId, customerId, keyId, kind,
    entitledVersion: version, issuedAt, priorLicenseId,
    installationId: request.installationId, deviceClaims: clone(request.claims),
  };
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('issuer must use Ed25519');
  const signature = sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64url');
  return { payload, signature };
}

function versionLeq(current, entitled) {
  const a = current.split('.').map(Number), b = entitled.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return true;
}

/** A valid signature, same installation and >=2 matching hardware claims are required. */
export function verifyLicense({ license, publicKeyPem, request, runningVersion, allowedKeyIds = undefined }) {
  try {
    validateDeviceRequest(request);
    if (!isRecord(license) || !isRecord(license.payload) || typeof license.signature !== 'string' || !/^[\w-]{86}$/.test(license.signature)) fail('invalid license envelope');
    const p = license.payload;
    if (p.schema !== 1 || p.product !== PRODUCT) fail('wrong product');
    nonempty(p.licenseId, 'licenseId');
    nonempty(p.customerId, 'customerId');
    nonempty(p.keyId, 'keyId');
    if (!ALLOWED_KIND.has(p.kind)) fail('invalid kind');
    assertUtc(p.issuedAt, 'issuedAt');
    if (!/^\d+\.\d+\.\d+$/.test(p.entitledVersion) || !/^\d+\.\d+\.\d+$/.test(runningVersion)) fail('invalid version');
    if (allowedKeyIds !== undefined && (!Array.isArray(allowedKeyIds) || !allowedKeyIds.includes(p.keyId))) fail('unknown signing key');
    const signature = Buffer.from(license.signature, 'base64url');
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') fail('issuer must use Ed25519');
    if (signature.length !== 64 || !verify(null, Buffer.from(canonical(p)), publicKey, signature)) fail('signature mismatch');
    if (p.installationId !== request.installationId) fail('different installation');
    if (!isRecord(p.deviceClaims)) fail('missing device claims');
    const matching = DEVICE_FIELDS.filter(field => p.deviceClaims[field] === request.claims[field]).length;
    if (matching < 2) fail('device fingerprint does not match');
    if (!versionLeq(runningVersion, p.entitledVersion)) fail('version is not licensed');
    return { valid: true, licenseId: p.licenseId, entitledVersion: p.entitledVersion, matchingDeviceClaims: matching };
  } catch (error) { return { valid: false, reason: error.message }; }
}
