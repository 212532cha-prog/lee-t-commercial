import { createPublicKey } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

try {
  const { LEE_T_OFFLINE_ISSUER_KEY_ID: keyId, LEE_T_OFFLINE_ISSUER_PUBLIC_KEY: encoded } = process.env;
  if (!keyId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId) || !encoded ||
      !/^[A-Za-z0-9+/]{59}=$/.test(encoded)) {
    throw Error();
  }
  const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519' || key.export({ format: 'der', type: 'spki' }).toString('base64') !== encoded) {
    throw Error();
  }
  const directory = process.argv[2];
  await writeFile(join(directory, 'issuer-public.pem'), key.export({ format: 'pem', type: 'spki' }), { flag: 'wx' });
  await writeFile(join(directory, 'issuer-id.txt'), keyId, { flag: 'wx' });
} catch {
  console.error('Provide an Ed25519 SPKI public key in base64 and a valid issuer key ID.');
  process.exitCode = 1;
}
