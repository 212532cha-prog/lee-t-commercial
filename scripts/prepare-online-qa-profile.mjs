import { createPublicKey, X509Certificate } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { activationEndpoint, activationPath } from '../src/commercial/activation-client.mjs';

const profile = JSON.parse(process.env.LEE_T_ONLINE_QA_PROFILE ?? 'null');
if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
    Object.keys(profile).length !== 4 || !/^leet-online-qa-[a-f0-9]{8}$/.test(profile.issuerKeyId ?? '')) {
  throw Error('Invalid online QA issuer profile.');
}
const endpoint = activationEndpoint({ LEE_T_ACTIVATION_ENDPOINT: profile.endpoint });
const [first, second] = endpoint.hostname.split('.').map(Number);
if (!isIPv4(endpoint.hostname) || endpoint.pathname !== activationPath ||
    !(endpoint.hostname === '127.0.0.1' || first === 10 || (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)) || endpoint.href !== profile.endpoint) {
  throw Error('Use the isolated LAN HTTPS redemption endpoint.');
}
function onePem(pem, label) {
  if (typeof pem !== 'string' || pem.length > 16384 ||
      !new RegExp('^-----BEGIN ' + label + '-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+-----END ' + label + '-----\\r?\\n?$').test(pem)) {
    throw Error('Expected one public PEM block.');
  }
  return pem;
}
const publicKey = onePem(profile.issuerPublicKey, 'PUBLIC KEY');
if (createPublicKey(publicKey).asymmetricKeyType !== 'ed25519') throw Error('Expected an Ed25519 public key.');
const ca = onePem(profile.activationCa, 'CERTIFICATE');
if (!new X509Certificate(ca).ca) throw Error('Expected a CA certificate.');

const output = process.argv[2];
await mkdir(output, { recursive: true });
await writeFile(join(output, 'issuer-public.pem'), publicKey, { flag: 'wx' });
await writeFile(join(output, 'activation-ca.pem'), ca, { flag: 'wx' });
await writeFile(join(output, 'build.json'), JSON.stringify({
  endpoint: endpoint.href, issuerKeyId: profile.issuerKeyId,
}), { flag: 'wx' });
